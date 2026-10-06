//! Manages loopback recording (recording system audio output)

use std::{
    ffi::{c_char, c_int, c_void, CStr},
    mem::MaybeUninit,
    ptr::NonNull,
    sync::{atomic::{AtomicU32, Ordering}, OnceLock},
};

static AGGREGATE_INSTANCE_COUNTER: AtomicU32 = AtomicU32::new(0);

use objc2::{msg_send, rc::{Allocated, Retained}, runtime::AnyClass, sel, AnyThread};
use objc2_core_audio::{
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioEndPointDeviceIsPrivateKey, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    AudioHardwareCreateAggregateDevice, AudioHardwareDestroyAggregateDevice,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
    CATapMuteBehavior,
};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

use super::device::Device;
use crate::{host::coreaudio::check_os_status, Error, ErrorKind};
type CFStringRef = *mut std::os::raw::c_void;

// The optional functions are resolved only on the loopback path, never by dyld
// as mandatory imports. A successful load retains one framework reference for
// this process's lifetime, so every created tap's destroy pointer stays valid.
type CreateProcessTap = unsafe extern "C-unwind" fn(
    Option<&CATapDescription>,
    *mut AudioObjectID,
) -> i32;
type DestroyProcessTap = unsafe extern "C-unwind" fn(AudioObjectID) -> i32;

struct ProcessTapApi {
    create: CreateProcessTap,
    destroy: DestroyProcessTap,
}

static PROCESS_TAP_API: OnceLock<Option<ProcessTapApi>> = OnceLock::new();

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
}

fn process_tap_unavailable() -> Error {
    Error::with_message(
        ErrorKind::UnsupportedOperation,
        "CoreAudio process taps are unavailable on this system",
    )
}

fn process_tap_api() -> Result<&'static ProcessTapApi, Error> {
    if !objc2::available!(macos = 14.2) {
        return Err(process_tap_unavailable());
    }
    PROCESS_TAP_API
        .get_or_init(load_process_tap_api)
        .as_ref()
        .ok_or_else(process_tap_unavailable)
}

fn load_process_tap_api() -> Option<ProcessTapApi> {
    // Darwin RTLD_LAZY (1) | RTLD_LOCAL (4); no user path or global search.
    let handle = unsafe {
        dlopen(
            c"/System/Library/Frameworks/CoreAudio.framework/CoreAudio".as_ptr(),
            1 | 4,
        )
    };
    if handle.is_null() {
        return None;
    }
    let create = unsafe { dlsym(handle, c"AudioHardwareCreateProcessTap".as_ptr()) };
    let destroy = unsafe { dlsym(handle, c"AudioHardwareDestroyProcessTap".as_ptr()) };
    if create.is_null() || destroy.is_null() {
        // No tap was created, so this failed reference can be released.
        unsafe { dlclose(handle) };
        return None;
    }
    // SAFETY: The two fixed symbols in the system framework have the exact
    // signatures declared in objc2-core-audio 0.3.2. Only Apple 64-bit targets
    // compile this module. Retaining handle keeps both functions loaded.
    Some(ProcessTapApi {
        create: unsafe { std::mem::transmute::<*mut c_void, CreateProcessTap>(create) },
        destroy: unsafe { std::mem::transmute::<*mut c_void, DestroyProcessTap>(destroy) },
    })
}

fn process_tap_class() -> Result<&'static AnyClass, Error> {
    let class = AnyClass::get(c"CATapDescription").ok_or_else(process_tap_unavailable)?;
    class.class_method(sel!(alloc)).ok_or_else(process_tap_unavailable)?;
    for selector in [
        sel!(initWithProcesses:andDeviceUID:withStream:),
        sel!(setMuteBehavior:),
        sel!(setName:),
        sel!(setPrivate:),
        sel!(setExclusive:),
        sel!(UUID),
    ] {
        class.instance_method(selector).ok_or_else(process_tap_unavailable)?;
    }
    let uuid_class = AnyClass::get(c"NSUUID").ok_or_else(process_tap_unavailable)?;
    uuid_class.instance_method(sel!(UUIDString)).ok_or_else(process_tap_unavailable)?;
    Ok(class)
}

impl Device {
    fn uid(&self) -> Result<Retained<NSString>, Error> {
        let mut cfstring: CFStringRef = std::ptr::null_mut();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;

        let property = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };

        let status = unsafe {
            AudioObjectGetPropertyData(
                self.audio_device_id,
                NonNull::from(&property),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut cfstring).cast(),
            )
        };
        check_os_status(status)?;

        if cfstring.is_null() {
            return Err(ErrorKind::DeviceNotAvailable.into());
        }

        let ns_string: Retained<NSString> = unsafe {
            // unwrap cause cfstring!=null as checked before
            Retained::retain(cfstring as *mut NSString).unwrap()
        };

        Ok(ns_string)
    }
}

/// An aggregate device with tap for recording system output.
///
/// Its main difference with [`Device`] is that it's destroyed when dropped.
///
/// It also doesn't implement the [`DeviceTrait`] as users shouldn't be using it. Its
/// main purpose is to destroy the created aggregate device when loopback recording
/// is done.
#[derive(PartialEq, Eq)]
pub struct LoopbackDevice {
    pub tap_id: AudioObjectID,
    pub aggregate_device: Device,
}

impl LoopbackDevice {
    /// Create a [`LoopbackDevice`] that records the sound
    /// output of `device`.
    pub fn from_device(device: &Device) -> Result<Self, Error> {
        // Refuse missing APIs/classes/selectors before allocation or audio effects.
        let tap_api = process_tap_api()?;
        let tap_class = process_tap_class()?;
        // 1 - Create tap

        let pid = std::process::id();
        let instance = AGGREGATE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);

        // Empty list of processes as we want to record all processes
        let processes = NSArray::new();
        let device_uid = device.uid()?;
        // Allocate the checked dynamic class; do not use CATapDescription::class().
        let allocated: Allocated<CATapDescription> = unsafe { msg_send![tap_class, alloc] };
        let tap_desc = unsafe {
            CATapDescription::initWithProcesses_andDeviceUID_withStream(
                allocated,
                &processes,
                device_uid.as_ref(),
                0,
            )
        };
        unsafe {
            tap_desc.setMuteBehavior(CATapMuteBehavior::Unmuted); // captured audio still goes to speakers
            tap_desc.setName(&NSString::from_str(&format!(
                "cpal output recorder {pid}.{instance}"
            )));
            tap_desc.setPrivate(true); // the Aggregate Device would be private
            tap_desc.setExclusive(true); // the process list means exclude them
        };

        let mut tap_obj_id: MaybeUninit<AudioObjectID> = MaybeUninit::uninit();
        let tap_obj_id = unsafe {
            let status =
                (tap_api.create)(Some(tap_desc.as_ref()), tap_obj_id.as_mut_ptr());
            check_os_status(status)?;
            tap_obj_id.assume_init()
        };
        let tap_uid = unsafe { tap_desc.UUID().UUIDString() };

        // 2 - Create aggregate device
        let aggregate_device_properties = create_audio_aggregate_device_properties(
            tap_uid,
            &format!("com.cpal.LoopbackRecordAggregateDevice.{pid}.{instance}"),
            &format!("Cpal loopback aggregate {pid}.{instance}"),
        );
        let mut aggregate_device_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                aggregate_device_properties.as_ref(),
                NonNull::from(&mut aggregate_device_id),
            )
        };
        if let Err(error) = check_os_status(status) {
            // Preserve the aggregate failure while releasing the created tap.
            unsafe { (tap_api.destroy)(tap_obj_id) };
            return Err(error);
        }

        Ok(Self {
            tap_id: tap_obj_id,
            aggregate_device: Device::new(aggregate_device_id),
        })
    }
}

impl Drop for LoopbackDevice {
    fn drop(&mut self) {
        unsafe {
            // We don't check status to avoid panic during `drop`
            let _status =
                AudioHardwareDestroyAggregateDevice(self.aggregate_device.audio_device_id);
            // A tap created by from_device has this same process-lifetime pair.
            if let Some(Some(tap_api)) = PROCESS_TAP_API.get() {
                let _status = (tap_api.destroy)(self.tap_id);
            }
        }
    }
}

fn to_cfstring(cstr: &'static CStr) -> CFRetained<CFString> {
    unsafe {
        CFString::with_c_string(
            kCFAllocatorDefault,
            cstr.as_ptr(),
            0x08000100, /* UTF8 */
        )
    }
    .unwrap()
}

/// Rust reimplementation of the following:
/// ```c
/// tap_uid = [[tap_description UUID] UUIDString];
/// taps = @[
///     @{
///         @kAudioSubTapUIDKey : (NSString*)tap_uid,
///         @kAudioSubTapDriftCompensationKey : @YES,
///     },
/// ];
///
/// aggregate_device_properties = @{
///     @kAudioAggregateDeviceNameKey : @"MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceUIDKey :
///         @"com.josephlyncheski.MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceTapListKey : taps,
///     @kAudioAggregateDeviceTapAutoStartKey : @YES,
///     @kAudioAggregateDeviceIsPrivateKey : @YES,
/// };
/// ```
pub fn create_audio_aggregate_device_properties(
    tap_uid: Retained<NSString>,
    agg_uid: &str,
    agg_name: &str,
) -> CFRetained<CFDictionary> {
    let tap_inner = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        dict
    };
    let _taps_list = [tap_inner];
    let taps = unsafe {
        CFArray::new(
            kCFAllocatorDefault,
            _taps_list.as_ptr() as *mut *const c_void,
            _taps_list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };
    let aggregate_dev_properties = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            5,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceNameKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_name) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceUIDKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_uid) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapListKey) as *const _ as *const c_void,
            &*taps as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapAutoStartKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioEndPointDeviceIsPrivateKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        CFRetained::cast_unchecked::<CFDictionary>(dict)
    };

    aggregate_dev_properties
}
