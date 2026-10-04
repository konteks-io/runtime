import { RemoteInstanceError } from "@konteks/remote-common";
import type { Output } from "./output.js";

export type SetupLocale = "en" | "id";
type Values = Readonly<Record<string, string | number>>;
type ErrorValues = Values | ((locale: SetupLocale) => Values);

/** Foreground setup copy only. Technical values and provider output are never translated. */
const COPY = {
  error: ["error ({code}): {detail}", "Kesalahan ({code}): {detail}"],
  unknownError: ["error: {detail}", "Kesalahan: {detail}"],
  hiddenInput: ["{label} (input hidden): ", "{label} (input disembunyikan): "],
  oneTimeCode: ["One-time code", "Kode sekali pakai"],
  interactiveInput: ["{label} must be entered interactively; run this command in a terminal", "{label} harus dimasukkan secara interaktif; jalankan perintah ini di terminal"],
  inputInterrupted: ["{label} entry was interrupted", "Pengisian {label} terhenti"],
  inputLength: ["{label} has an unexpected length", "Panjang {label} tidak sesuai"],
  confirmation: ["{question} [y/N] ", "{question} [y=ya/N=tidak] "],
  consentYes: ["Answered yes with --yes.", "Jawaban ya diberikan melalui --yes."],
  consentMissing: ["Nothing was downloaded: answer the question above in a terminal, or run the command again with --yes once you agree.", "Tidak ada yang diunduh: jawab pertanyaan di atas di terminal, atau jalankan kembali perintah dengan --yes setelah Anda menyetujuinya."],
  antigravityConsent: ["Konteks will download Google Antigravity from Google's server (dl.google.com, about 110 MB, 400 MB on disk), check Google's signature, and keep it updated with Konteks updates. Google's terms apply to its use (antigravity.google/terms). Download it now? [y/N]", "Konteks akan mengunduh Google Antigravity dari server Google (dl.google.com, sekitar 110 MB, 400 MB di disk), memeriksa tanda tangan Google, dan memperbaruinya bersama pembaruan Konteks. Ketentuan Google berlaku untuk penggunaannya (antigravity.google/terms). Unduh sekarang? [y=ya/N=tidak]"],
  gitHint: ["Claude Code needs Git for Windows: {url}", "Claude Code memerlukan Git for Windows: {url}"],
  gitOffer: ["Claude Code needs Git for Windows. Install it with winget (Git.Git) first?", "Claude Code memerlukan Git for Windows. Pasang terlebih dahulu dengan winget (Git.Git)?"],
  gitInstalling: ["Installing Git for Windows with winget…", "Memasang Git for Windows dengan winget…"],
  gitWingetMissing: ["winget is not available here. {hint}", "winget tidak tersedia di sini. {hint}"],
  gitInstallFailed: ["Git for Windows did not install. {hint}", "Git for Windows tidak berhasil dipasang. {hint}"],
  codexOffer: ["Codex is not set up here. It comes with Konteks, so nothing is downloaded. Set it up and sign in with your ChatGPT account?", "Codex belum disiapkan di sini. Codex disertakan bersama Konteks, sehingga tidak ada yang diunduh. Siapkan dan masuk dengan akun ChatGPT Anda?"],
  codexSetupFailed: ["Codex could not be set up here: its folder (CODEX_HOME) must be yours and private. To try again: konteks-remote agent add codex", "Codex tidak dapat disiapkan di sini: foldernya (CODEX_HOME) harus milik Anda dan bersifat privat. Untuk mencoba lagi: konteks-remote agent add codex"],
  claudeOffer: ["Claude Code is not installed. Install it with Anthropic's official installer ({url}) and sign in?", "Claude Code belum terpasang. Pasang dengan pemasang resmi Anthropic ({url}) dan masuk?"],
  claudeInstalling: ["Installing Claude Code with Anthropic's installer…", "Memasang Claude Code dengan pemasang Anthropic…"],
  claudeInstallFailed: ["Claude Code's installer did not finish. To try again: {command}", "Pemasang Claude Code tidak selesai. Untuk mencoba lagi: {command}"],
  claudeNotFound: ["Claude Code was installed but is not found yet. Open a new terminal, then: {command}", "Claude Code telah dipasang tetapi belum ditemukan. Buka terminal baru, lalu: {command}"],
  codexNotSetUp: ["Codex is not set up for this user. Run this in a terminal to set it up and sign in: konteks-remote agent add codex", "Codex belum disiapkan untuk pengguna ini. Jalankan di terminal untuk menyiapkan dan masuk: konteks-remote agent add codex"],
  claudeNotInstalled: ["Claude Code is not installed for this user. Install it with Anthropic's installer ({command}), then: konteks-remote agent add claude-code{git}", "Claude Code belum terpasang untuk pengguna ini. Pasang dengan pemasang Anthropic ({command}), lalu: konteks-remote agent add claude-code{git}"],
  agentNotAdded: ["{name} was not added.", "{name} tidak ditambahkan."],
  agentDeclinedInstall: ["Nothing was installed: {name} was not added.", "Tidak ada yang dipasang: {name} tidak ditambahkan."],
  agentDeclinedChange: ["Nothing was changed: {name} was not added.", "Tidak ada yang diubah: {name} tidak ditambahkan."],
  agentsChecking: ["Checking which agents are ready…", "Memeriksa agen yang siap…"],
  agentSignInOffer: ["{name} is here but not signed in. Sign in now?", "{name} tersedia tetapi belum masuk. Masuk sekarang?"],
  agentsReady: ["Ready to work here: {names}.", "Siap bekerja di sini: {names}."],
  agentsNoneReady: ["No coding agent is ready here yet.", "Belum ada agen pemrograman yang siap di sini."],
  namesAnd: ["{names} and {last}", "{names} dan {last}"],
  agentAddHint: ["To add {name}: konteks-remote agent add {agent}", "Untuk menambahkan {name}: konteks-remote agent add {agent}"],
  agentNeedsLogin: ["{name} needs you to sign in: konteks-remote auth login {agent}", "Anda perlu masuk ke {name}: konteks-remote auth login {agent}"],
  agentStartFailed: ["{name} could not start here; to see why: konteks-remote doctor", "{name} tidak dapat dimulai di sini; untuk melihat penyebabnya: konteks-remote doctor"],
  agentStarting: ["{name} is still starting; konteks-remote agents shows when it is ready.", "{name} masih dimulai; konteks-remote agents menunjukkan saat agen siap."],
  installConnecting: ["Connecting this computer to Konteks. Type the one-time code from the site.", "Menghubungkan komputer ini ke Konteks. Ketik kode sekali pakai dari situs."],
  installUnpacking: ["Code accepted. Unpacking the agents on this computer; this takes about a minute.", "Kode diterima. Mengekstrak agen di komputer ini; proses ini memerlukan sekitar satu menit."],
  installSettingUp: ["Code accepted. Setting up Konteks on this computer…", "Kode diterima. Menyiapkan Konteks di komputer ini…"],
  installUnpackAgent: ["Unpacking {name} ({number} of {total})…", "Mengekstrak {name} ({number} dari {total})…"],
  installComplete: ["Installed. Starting Konteks on this computer next.", "Terpasang. Selanjutnya, Konteks akan dimulai di komputer ini."],
  installInvalid: ["Native installation cannot be completed; existing identity and credentials were preserved.", "Pemasangan native tidak dapat diselesaikan; identitas dan kredensial yang ada tetap tersimpan."],
  offlineInstallRequired: ["Native agents require a complete signed offline package with official login tooling.", "Agen native memerlukan paket offline bertanda tangan yang lengkap dengan alat masuk resmi."],
  noControlPort: ["No local control port is available; the native connector was not changed.", "Tidak ada port kontrol lokal yang tersedia; konektor native tidak diubah."],
  occupiedService: ["This connector's service is still registered or running. Stop this installation's service before retrying start; its identity and local work are unchanged.", "Layanan konektor ini masih terdaftar atau berjalan. Hentikan layanan pemasangan ini sebelum mencoba memulai lagi; identitas dan pekerjaan lokalnya tidak berubah."],
  startingService: ["This connector's service began starting. Stop this installation's service before retrying start; its identity and local work are unchanged.", "Layanan konektor ini mulai berjalan. Hentikan layanan pemasangan ini sebelum mencoba memulai lagi; identitas dan pekerjaan lokalnya tidak berubah."],
  agentAlreadyInstalled: ["{agent} is already installed; no files or identity were changed.", "{agent} sudah terpasang; tidak ada berkas atau identitas yang diubah."],
  agentAdded: ["{name} added; your other agents, sign-ins and work are unchanged.", "{name} ditambahkan; agen lain, akun yang masuk, dan pekerjaan Anda tidak berubah."],
  agentHostAdded: ["{name} added from this machine's own installation; no release was downloaded and nothing else changed. To sign it in here: konteks-remote auth login {agent}", "{name} ditambahkan dari pemasangan di komputer ini; tidak ada rilis yang diunduh dan tidak ada perubahan lain. Untuk masuk di sini: konteks-remote auth login {agent}"],
  agentGoogleDownloading: ["Downloading {name} from Google and checking Google's signature; this takes a minute or two.", "Mengunduh {name} dari Google dan memeriksa tanda tangan Google; proses ini memerlukan satu atau dua menit."],
  agentGoogleRefetched: ["{name} downloaded from Google again and its signature checked; its sign-ins were kept.", "{name} diunduh lagi dari Google dan tanda tangannya diperiksa; akun yang masuk tetap tersimpan."],
  agentGoogleAdded: ["{name} added: downloaded from Google and its signature checked; nothing else changed. To sign it in here with a Gemini API key: konteks-remote auth login {agent} --api-key. With Gemini Enterprise: konteks-remote auth login {agent} --enterprise --project <project id>", "{name} ditambahkan: diunduh dari Google dan tanda tangannya diperiksa; tidak ada perubahan lain. Untuk masuk dengan kunci Gemini API: konteks-remote auth login {agent} --api-key. Dengan Gemini Enterprise: konteks-remote auth login {agent} --enterprise --project <project id>"],
  agentDownloadDeclined: ["Nothing was downloaded: {name} was not added.", "Tidak ada yang diunduh: {name} tidak ditambahkan."],
  agentNotOffered: ["{agent} cannot be added on this computer yet.", "{agent} belum dapat ditambahkan di komputer ini."],
  signInOpenUrl: ["open this URL to sign in: {url}{code}", "buka URL ini untuk masuk: {url}{code}"],
  signInEnterCode: ["\nenter code: {code}", "\nmasukkan kode: {code}"],
  signInStarting: ["Starting {name}'s own sign-in. Follow its steps below.", "Memulai proses masuk milik {name}. Ikuti langkah-langkah di bawah."],
  signInReady: ["{name} is ready{organization}.", "{name} siap{organization}."],
  signInOrganization: [" for your organization", " untuk organisasi Anda"],
  signInNotReady: ["{name} is signed in but not ready yet; konteks-remote doctor says why.", "Anda telah masuk ke {name} tetapi agen belum siap; konteks-remote doctor menunjukkan penyebabnya."],
  closeWindow: [" You can close this window.", " Anda dapat menutup jendela ini."],
  organizationAttestation: ["Attest that the {agent} account you are about to log in is owned by your organization and may serve colleagues' work?", "Nyatakan bahwa akun {agent} yang akan Anda gunakan untuk masuk dimiliki organisasi Anda dan boleh melayani pekerjaan rekan kerja?"],
  organizationDeclined: ["organization attestation declined; log in without --organization for a personal account", "pernyataan kepemilikan organisasi ditolak; masuk tanpa --organization untuk akun pribadi"],
  serviceAlreadyRunning: ["Konteks is already running on this computer; konteks-remote status shows how it is doing.", "Konteks sudah berjalan di komputer ini; konteks-remote status menunjukkan kondisinya."],
  serviceStarting: ["Konteks is starting on this computer and is ready for work within a minute; konteks-remote status shows how it is doing.", "Konteks sedang dimulai di komputer ini dan siap bekerja dalam satu menit; konteks-remote status menunjukkan kondisinya."],
  serviceStillStarting: ["Konteks is still starting on this computer; waiting for it…", "Konteks masih dimulai di komputer ini; menunggu…"],
  serviceLinger: ["This Linux user service needs user lingering to remain available after logout. Configure it explicitly if required.", "Layanan pengguna Linux ini memerlukan user lingering agar tetap tersedia setelah keluar. Atur secara eksplisit jika diperlukan."],
  servicePortMoved: ["Another program uses port {previous}, so Konteks uses port {current} on this computer instead.", "Program lain menggunakan port {previous}, sehingga Konteks menggunakan port {current} di komputer ini."],
  serviceStartFailed: ["The native user service could not start: {detail} Installed identity and credentials were preserved.", "Layanan pengguna native tidak dapat dimulai: {detail} Identitas dan kredensial yang terpasang tetap tersimpan."],
  serviceWriteFailed: ["The service definition could not be written to {path} ({detail}).", "Definisi layanan tidak dapat ditulis ke {path} ({detail})."],
  serviceWindowsRegister: ["Windows refused to create the Konteks task", "Windows menolak pembuatan tugas Konteks"],
  serviceWindowsStart: ["Windows did not run the Konteks task", "Windows tidak menjalankan tugas Konteks"],
  serviceWindowsStop: ["Windows did not end the Konteks task", "Windows tidak menghentikan tugas Konteks"],
  serviceWindowsStatus: ["Windows could not say whether the Konteks task is running", "Windows tidak dapat memastikan apakah tugas Konteks berjalan"],
  serviceMacLoad: ["macOS did not load the Konteks launch agent", "macOS tidak memuat agen launch Konteks"],
  serviceMacStop: ["macOS did not unload the Konteks launch agent", "macOS tidak melepas agen launch Konteks"],
  serviceMacStatus: ["macOS could not say whether the Konteks launch agent is running", "macOS tidak dapat memastikan apakah agen launch Konteks berjalan"],
  serviceLinuxRegister: ["systemd did not reload its user services", "systemd tidak memuat ulang layanan penggunanya"],
  serviceLinuxStart: ["systemd did not start the Konteks user service", "systemd tidak memulai layanan pengguna Konteks"],
  serviceLinuxStop: ["systemd did not stop the Konteks user service", "systemd tidak menghentikan layanan pengguna Konteks"],
  serviceLinuxStatus: ["systemd could not say whether the Konteks user service is running", "systemd tidak dapat memastikan apakah layanan pengguna Konteks berjalan"],
  serviceAdminRemedy: ["Run konteks-remote start once from an administrator PowerShell (right-click PowerShell, Run as administrator); Konteks still runs as you.", "Jalankan konteks-remote start sekali dari PowerShell administrator (klik kanan PowerShell, Run as administrator); Konteks tetap berjalan sebagai Anda."],
  serviceTaskRemedy: ["This copy of konteks-remote wrote a task Windows does not accept; run konteks-remote update, then konteks-remote start. If it stays, send konteks-remote support to Konteks support.", "Salinan konteks-remote ini menulis tugas yang ditolak Windows; jalankan konteks-remote update, lalu konteks-remote start. Jika tetap terjadi, kirim konteks-remote support ke dukungan Konteks."],
  serviceSchedulerRemedy: ["Start the Task Scheduler service (services.msc), then run konteks-remote start again.", "Mulai layanan Task Scheduler (services.msc), lalu jalankan konteks-remote start lagi."],
  serviceMacRemedy: ["Run konteks-remote stop, then konteks-remote start.", "Jalankan konteks-remote stop, lalu konteks-remote start."],
  serviceTimeoutRemedy: ["Run konteks-remote start again; if it keeps timing out, restart the computer.", "Jalankan konteks-remote start lagi; jika terus kehabisan waktu, mulai ulang komputer."],
  serviceFolderRemedy: ["Check that this folder is yours and the disk has space, then run konteks-remote start again.", "Pastikan folder ini milik Anda dan disk memiliki ruang kosong, lalu jalankan konteks-remote start lagi."],
  serviceVerboseRemedy: ["To see every step, run konteks-remote --verbose start.", "Untuk melihat setiap langkah, jalankan konteks-remote --verbose start."],
  serviceExited: ["it started and stopped again at once.{tail} The whole log: {path}.", "layanan langsung berhenti setelah dimulai.{tail} Log lengkap: {path}."],
  serviceLogTail: [" The connector log ends: {tail}", " Bagian akhir log konektor: {tail}"],
  serviceUnconfirmedStopped: ["The service manager cannot confirm this installation is stopped. Inspect and stop only this installation's service before retrying start; identity and local work are unchanged.", "Pengelola layanan tidak dapat memastikan bahwa pemasangan ini berhenti. Periksa dan hentikan hanya layanan pemasangan ini sebelum mencoba memulai lagi; identitas dan pekerjaan lokal tidak berubah."],
  serviceSocketUnavailable: ["This installation's service is registered or starting, but its control socket on port {port} is unavailable. Stop only this installation's service, then run start again to repair an occupied port; identity and local work are preserved.", "Layanan pemasangan ini terdaftar atau sedang dimulai, tetapi soket kontrolnya pada port {port} tidak tersedia. Hentikan hanya layanan pemasangan ini, lalu jalankan start lagi untuk memperbaiki port yang terpakai; identitas dan pekerjaan lokal tetap tersimpan."],
  serviceStopped: ["Konteks is stopped on this computer. Your sign-ins and work are kept; konteks-remote start starts it again.", "Konteks berhenti di komputer ini. Akun yang masuk dan pekerjaan Anda tetap tersimpan; konteks-remote start memulainya lagi."],
  serviceStoppedStatus: ["Konteks is stopped on this computer. konteks-remote start starts it again.", "Konteks berhenti di komputer ini. konteks-remote start memulainya lagi."],
  serviceStopping: ["Stopping Konteks on this computer…", "Menghentikan Konteks di komputer ini…"],
  serviceStopFailed: ["Konteks could not be stopped on this computer ({detail}); konteks-remote --verbose stop shows every step.", "Konteks tidak dapat dihentikan di komputer ini ({detail}); konteks-remote --verbose stop menunjukkan setiap langkah."],
  serviceStopUnacknowledged: ["The connector did not acknowledge shutdown; waiting for its owned processes to close…", "Konektor belum mengonfirmasi penghentian; menunggu proses miliknya selesai…"],
  serviceStoppedAgentsClosing: ["Konteks stopped, but its agents may still be closing. Wait a moment, then check with konteks-remote status.", "Konteks berhenti, tetapi agennya mungkin masih menutup. Tunggu sebentar, lalu periksa dengan konteks-remote status."],
  serviceAlreadyStopped: ["Konteks is already stopped on this computer.", "Konteks sudah berhenti di komputer ini."],
  serviceUnconfirmedRunning: ["Konteks could not tell whether it is running on this computer, so nothing was stopped; konteks-remote doctor says why.", "Konteks tidak dapat memastikan apakah berjalan di komputer ini, sehingga tidak ada yang dihentikan; konteks-remote doctor menunjukkan penyebabnya."],
  agentUnpacking: ["The agent packages are still unpacking on this machine.", "Paket agen masih diekstrak di komputer ini."],
  agentRequiresNewRelease: ["Adding an agent requires a newer signed native release; stale or same-version manifests are refused.", "Menambahkan agen memerlukan rilis native bertanda tangan yang lebih baru; manifest lama atau dengan versi sama ditolak."],
  agentAfterOnboarding: ["{name} is added after onboarding, once you agree to its download: konteks-remote agent add {agent}", "{name} ditambahkan setelah penyiapan awal, setelah Anda menyetujui unduhannya: konteks-remote agent add {agent}"],
  agentNoRestart: ["{name} is already installed; no restart is needed.", "{name} sudah terpasang; tidak perlu memulai ulang."],
  agentStateUnconfirmed: ["The service manager cannot confirm this installation's service state. Inspect only this installation's service before adding an agent; identity and local work are unchanged.", "Pengelola layanan tidak dapat memastikan status layanan pemasangan ini. Periksa hanya layanan pemasangan ini sebelum menambahkan agen; identitas dan pekerjaan lokal tidak berubah."],
  agentWaitingAssignments: ["waiting for {number} active assignment(s) before installing {agent}…", "menunggu {number} penugasan aktif sebelum memasang {agent}…"],
  agentDrainTimedOut: ["Agent installation waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.", "Pemasangan agen telah menunggu pekerjaan aktif selama 15 menit; runtime tetap berjalan dan tidak menerima pekerjaan baru agar dapat diperiksa dengan aman."],
  agentStopTimedOut: ["The native runtime did not finish stopping; its installed agents were not changed.", "Runtime native belum selesai berhenti; agen yang terpasang tidak diubah."],
  agentForegroundStopping: ["Konteks is running in a terminal here, not as its background service; stopping it there to add the agent…", "Konteks berjalan di terminal ini, bukan sebagai layanan latar; menghentikannya untuk menambahkan agen…"],
  agentForegroundAdded: ["{name} is added. Konteks stopped to add it; konteks-remote start starts it again, in the background.", "{name} ditambahkan. Konteks berhenti untuk menambahkannya; konteks-remote start memulainya lagi di latar."],
  agentWaitingFiles: ["Waiting for the stopped connector to release its private data before adding the agent…", "Menunggu konektor yang dihentikan melepas data privatnya sebelum menambahkan agen…"],
  agentStartedAgain: ["This connector started again before agent installation; stop only this installation's service and retry.", "Konektor ini dimulai lagi sebelum pemasangan agen; hentikan hanya layanan pemasangan ini dan coba lagi."],
  agentForegroundStopped: ["Konteks stopped to add the agent and stays stopped; konteks-remote start starts it again, in the background.", "Konteks berhenti untuk menambahkan agen dan tetap berhenti; konteks-remote start memulainya lagi di latar."],
  agentRollbackFailed: ["Agent installation failed and automatic rollback could not restore the previous record; identity and local work were preserved.", "Pemasangan agen gagal dan pengembalian otomatis tidak dapat memulihkan catatan sebelumnya; identitas dan pekerjaan lokal tetap tersimpan."],
  agentRollbackCannotStop: ["The new service could not be stopped before agent rollback.", "Layanan baru tidak dapat dihentikan sebelum pengembalian agen."],
  agentRollbackUnconfirmed: ["The service manager cannot confirm the new service stopped before agent rollback.", "Pengelola layanan tidak dapat memastikan bahwa layanan baru berhenti sebelum pengembalian agen."],
  agentRollbackStopTimedOut: ["The new service did not finish stopping before agent rollback.", "Layanan baru belum selesai berhenti sebelum pengembalian agen."],
  agentStoppedUnconfirmed: ["The service manager cannot confirm this installation stopped; its identity and local work are unchanged.", "Pengelola layanan tidak dapat memastikan bahwa pemasangan ini berhenti; identitas dan pekerjaan lokalnya tidak berubah."],
  updateCurrent: ["Installed release {version} is current; nothing was changed.", "Rilis terpasang {version} sudah terbaru; tidak ada perubahan."],
  updateTaskUnconfirmed: ["Windows could not confirm this connector's task state; its installation was not changed.", "Windows tidak dapat memastikan status tugas konektor ini; pemasangannya tidak diubah."],
  updateCheckCurrent: ["Installed release {version} is current.", "Rilis terpasang {version} sudah terbaru."],
  updateNotAcceptedCheck: ["Release {version} is published, but Konteks accepts {accepted} for this machine, so it stays on {current} until Konteks accepts the new one.", "Rilis {version} telah diterbitkan, tetapi Konteks menerima {accepted} untuk komputer ini, sehingga rilis tetap {current} sampai Konteks menerima rilis baru."],
  updateNotAccepted: ["Release {version} is published, but Konteks accepts {accepted} for this machine, so nothing was changed; {current} keeps running until Konteks accepts the new one.", "Rilis {version} telah diterbitkan, tetapi Konteks menerima {accepted} untuk komputer ini, sehingga tidak ada perubahan; {current} tetap berjalan sampai Konteks menerima rilis baru."],
  updateAvailable: ["Release {version} is available (installed: {current}); run `konteks-remote update` to install it.", "Rilis {version} tersedia (terpasang: {current}); jalankan `konteks-remote update` untuk memasangnya."],
  updateAvailableFailed: ["Release {version} is available (installed: {current}), but {note}", "Rilis {version} tersedia (terpasang: {current}), tetapi {note}"],
  updateRetry: ["Trying again as asked: {note}", "Mencoba lagi sesuai permintaan: {note}"],
  updateSelf: ["Konteks updated itself to {version} at {at}.", "Konteks memperbarui dirinya ke {version} pada {at}."],
  updateEarlierFailed: ["failed here", "gagal di sini"],
  updateEarlierRolledBack: ["failed its health check here and was rolled back", "gagal dalam pemeriksaan kesehatan di sini dan dikembalikan ke rilis sebelumnya"],
  updateEarlier: ["{version} already {how} ({when}{detail}). Installing it again installs the same release; it is usually better to wait for a newer one.", "{version} sudah {how} ({when}{detail}). Memasangnya lagi akan memasang rilis yang sama; biasanya lebih baik menunggu rilis yang lebih baru."],
  updateStaging: ["Staging native release {version} (installed: {current})… Downloading, verifying and unpacking its signed packages can take a few minutes; leave this command running and return for the result.", "Menyiapkan rilis native {version} (terpasang: {current})… Mengunduh, memverifikasi, dan mengekstrak paket bertanda tangan memerlukan beberapa menit; biarkan perintah ini berjalan dan kembali untuk melihat hasilnya."],
  updateStaged: ["Release {version} staged as {release}; the running release is unchanged until it is committed.", "Rilis {version} disiapkan sebagai {release}; rilis yang berjalan tidak berubah sampai rilis baru diterapkan."],
  updateRecordMoved: ["Runtime record moved to {release} ({version}); {previous} is kept for rollback.", "Catatan runtime dipindahkan ke {release} ({version}); {previous} disimpan untuk pengembalian."],
  updateChannelUnreadable: ["The native release channel could not be read; the installed release is unchanged.", "Saluran rilis native tidak dapat dibaca; rilis terpasang tidak berubah."],
  updateBusy: ["Another update or install of this connector is still running (it may be downloading a release). Wait for it to finish, then run `konteks-remote status`.", "Pembaruan atau pemasangan lain untuk konektor ini masih berjalan (mungkin sedang mengunduh rilis). Tunggu sampai selesai, lalu jalankan `konteks-remote status`."],
  updateTargetChanged: ["The signed update target changed; the installed release is unchanged.", "Target pembaruan bertanda tangan berubah; rilis terpasang tidak berubah."],
  updateOfflineRequired: ["Native updates require a complete signed offline package with official login tooling.", "Pembaruan native memerlukan paket offline bertanda tangan yang lengkap dengan alat masuk resmi."],
  updateNotNewer: ["Only a strictly newer signed release can be committed; stale or same-version releases are refused.", "Hanya rilis bertanda tangan yang benar-benar lebih baru yang dapat diterapkan; rilis lama atau dengan versi sama ditolak."],
  updateInvalid: ["Native update cannot be completed; the installed release, identity and credentials were preserved.", "Pembaruan native tidak dapat diselesaikan; rilis terpasang, identitas, dan kredensial tetap tersimpan."],
  updateStarting: ["Starting {version} and checking it is healthy before keeping it (rolled back if it makes no progress for {duration})…", "Memulai {version} dan memeriksa kesehatannya sebelum mempertahankannya (dikembalikan jika tidak ada kemajuan selama {duration})…"],
  updateComplete: ["Native connector updated {from} → {to}; {previous} is kept for rollback.", "Konektor native diperbarui {from} → {to}; {previous} disimpan untuk pengembalian."],
  updateShutdownUnacknowledged: ["The connector did not acknowledge shutdown; waiting for its owned processes to close before continuing…", "Konektor belum mengonfirmasi penghentian; menunggu proses miliknya selesai sebelum melanjutkan…"],
  updateStopFailed: ["The native runtime drained but could not stop; its installation was not changed.", "Runtime native telah dikosongkan tetapi tidak dapat berhenti; pemasangannya tidak diubah."],
  updateStopTimedOut: ["The native runtime did not finish stopping in time; its installation was not changed.", "Runtime native tidak selesai berhenti dalam batas waktu; pemasangannya tidak diubah."],
  updateLauncherFailed: ["konteks-remote itself could not be refreshed to {version} ({detail}); the connector is updated.", "konteks-remote sendiri tidak dapat diperbarui ke {version} ({detail}); konektornya telah diperbarui."],
  launcherDelegateFailed: ["konteks-remote: could not start the installed release {version}; running this installer's own copy instead.", "konteks-remote: rilis terpasang {version} tidak dapat dimulai; menjalankan salinan pemasang ini."],
  updateUnchangedRestartFailed: ["The unchanged connector could not be restarted; run `konteks-remote start`.", "Konektor yang tidak diubah tidak dapat dimulai ulang; jalankan `konteks-remote start`."],
  updateHealthFailed: ["Update to {version} failed its health gate; rolling back to {previous}.", "Pembaruan ke {version} gagal dalam pemeriksaan kesehatan; mengembalikan ke {previous}."],
  updateRollbackFailed: ["The updated connector did not pass its health gate and automatic rollback failed; identity, credentials and workspaces remain preserved.", "Konektor yang diperbarui gagal dalam pemeriksaan kesehatan dan pengembalian otomatis gagal; identitas, kredensial, dan ruang kerja tetap tersimpan."],
  updateRolledBack: ["Rolled back: {previous} is running and answering again. {version} was not kept.", "Dikembalikan: {previous} berjalan dan merespons lagi. {version} tidak dipertahankan."],
  updateRolledBackWaiting: ["Rolled back to {previous} and started it; it has not answered yet. Run `konteks-remote status` in a minute.", "Dikembalikan ke {previous} dan dimulai; rilis belum merespons. Jalankan `konteks-remote status` dalam satu menit."],
  updateStopping: ["Stopping the connector: it closes its agent sessions and relay first, which usually takes under a minute…", "Menghentikan konektor: sesi agen dan relay ditutup lebih dahulu, biasanya dalam waktu kurang dari satu menit…"],
  updateStillStopping: ["still stopping the connector", "masih menghentikan konektor"],
  updateForceStop: ["The connector did not stop within {duration}; ending its processes.", "Konektor tidak berhenti dalam {duration}; menghentikan proses miliknya."],
  updateAbortedRestart: ["The update did not go ahead; starting this computer's connector again on the release it had.", "Pembaruan tidak dilanjutkan; memulai kembali konektor komputer ini dengan rilis sebelumnya."],
  updateRestartFailed: ["The connector could not be started again; run `konteks-remote start`.", "Konektor tidak dapat dimulai lagi; jalankan `konteks-remote start`."],
  updateUnchangedRestored: ["{version} is running and answering again; nothing was changed.", "{version} berjalan dan merespons lagi; tidak ada perubahan."],
  updateUnchangedWaiting: ["{version} was started again but has not answered yet; run `konteks-remote status` in a minute.", "{version} dimulai lagi tetapi belum merespons; jalankan `konteks-remote status` dalam satu menit."],
  updateRollbackStopping: ["Stopping the updated connector before restoring the previous release…", "Menghentikan konektor yang diperbarui sebelum memulihkan rilis sebelumnya…"],
  updateRollbackStillStopping: ["still stopping the updated connector", "masih menghentikan konektor yang diperbarui"],
  updateRollbackCannotStop: ["The updated connector did not stop, so the previous release could not be restored.", "Konektor yang diperbarui tidak berhenti, sehingga rilis sebelumnya tidak dapat dipulihkan."],
  updateRollbackForceStop: ["The updated connector did not stop within {duration}; ending its processes.", "Konektor yang diperbarui tidak berhenti dalam {duration}; menghentikan proses miliknya."],
  updateRestarted: ["Started {version} again so this computer stays connected; run `konteks-remote status` to check it.", "Memulai {version} lagi agar komputer ini tetap terhubung; jalankan `konteks-remote status` untuk memeriksanya."],
  updateWaitingAgain: ["Waiting for {version} to answer again…", "Menunggu {version} merespons lagi…"],
  updateStillWaiting: ["still waiting for {version} to answer", "masih menunggu {version} merespons"],
  updateWaiting: ["Waiting for {version} to answer…", "Menunggu {version} merespons…"],
  updateElapsed: ["{again} ({seconds} s so far)…", "{again} (sudah {seconds} dtk)…"],
  durationMinutes: ["{number} min", "{number} menit"],
  durationSeconds: ["{number} s", "{number} dtk"],
  updateWaitingFiles: ["Waiting for the stopped connector to let go of its files…", "Menunggu konektor yang dihentikan melepas berkasnya…"],
  updateStillWaitingFiles: ["still waiting for the stopped connector to let go of its files", "masih menunggu konektor yang dihentikan melepas berkasnya"],
  updateActiveTimedOut: ["The update waited for active work past its deadline; the running release resumed accepting work and was not changed.", "Pembaruan menunggu pekerjaan aktif melewati batas waktu; rilis yang berjalan kembali menerima pekerjaan dan tidak diubah."],
  updateWaitingAssignments: ["waiting for {number} active assignment(s) before updating…", "menunggu {number} penugasan aktif sebelum memperbarui…"],
  updateAgentReconnect: ["agent {agent} needs a fresh login after this update: run `konteks-remote auth login {agent}`.", "agen {agent} memerlukan proses masuk baru setelah pembaruan ini: jalankan `konteks-remote auth login {agent}`."],
  updateWrongVersion: ["the service answering reports {actual}, not {expected}", "layanan yang merespons melaporkan {actual}, bukan {expected}"],
  updateExited: ["The updated connector stopped as soon as it started, {number} times (exit code {code}).", "Konektor yang diperbarui langsung berhenti setelah dimulai, sebanyak {number} kali (kode keluar {code})."],
  updateNoAnswer: ["The updated connector stopped making progress before it answered on its control socket.", "Konektor yang diperbarui berhenti menunjukkan kemajuan sebelum merespons pada soket kontrolnya."],
  updateAgentsStalled: ["The updated connector stopped making progress while probing its agents ({agents}).", "Konektor yang diperbarui berhenti menunjukkan kemajuan saat memeriksa agennya ({agents})."],
  updateDoctorFailed: ["The updated connector introduced doctor failure(s): {detail}.", "Konektor yang diperbarui menimbulkan kegagalan doctor: {detail}."],
  updateDoctorWaiting: ["waiting for the updated connector to clear doctor failure(s): {checks}…", "menunggu konektor yang diperbarui mengatasi kegagalan doctor: {checks}…"],
  updateAddedChecks: ["{version} reports a check {previous} did not have: {detail}. It is not held against the update.", "{version} melaporkan pemeriksaan yang tidak ada pada {previous}: {detail}. Hal ini tidak membuat pembaruan dianggap gagal."],
  actionRetry: ["retry the command", "coba jalankan perintah lagi"],
  actionDoctor: ["run `konteks-remote doctor`", "jalankan `konteks-remote doctor`"],
  actionLogin: ["run `konteks-remote auth login {agent}`", "jalankan `konteks-remote auth login {agent}`"],
  actionUpdate: ["run `konteks-remote update`", "jalankan `konteks-remote update`"],
  actionDisk: ["free disk space and retry", "kosongkan ruang disk dan coba lagi"],
  actionActivation: ["create a new activation in the Konteks App or MCP and rerun install", "buat aktivasi baru di App Konteks atau MCP dan jalankan pemasangan lagi"],
  actionSupport: ["run `konteks-remote doctor` and share the support bundle with Konteks support", "jalankan `konteks-remote doctor` dan bagikan paket dukungan ke dukungan Konteks"],
  actionRevoke: ["revoke or remove this runtime from the Konteks App or MCP", "cabut atau hapus runtime ini dari App Konteks atau MCP"],
  actionReselect: ["select another runtime for the workload", "pilih runtime lain untuk pekerjaan ini"],
  actionAntigravity: ["run `konteks-remote agent add antigravity`, which downloads Google's copy again after you say yes", "jalankan `konteks-remote agent add antigravity`, yang mengunduh salinan Google lagi setelah Anda menjawab ya"],
  actionInstallAgent: ["install a supported {name} as the message says, then run the command again", "pasang {name} yang didukung sesuai pesan, lalu jalankan perintah lagi"],
  actionInstall: ["install what the message names, then run the command again", "pasang komponen yang disebutkan dalam pesan, lalu jalankan perintah lagi"],
} as const;

export type SetupCopyKey = keyof typeof COPY;
const errorCopy = new WeakMap<Error, { key: SetupCopyKey; values: ErrorValues }>();

/** Validate before any foreground action; never retain locale in installation state. */
export function setupLocale(env: NodeJS.ProcessEnv = process.env): SetupLocale {
  const value = env.KONTEKS_SETUP_LOCALE;
  if (value === undefined) return "en";
  if (value === "en" || value === "id") return value;
  throw new RemoteInstanceError("prerequisite_missing", "KONTEKS_SETUP_LOCALE must be en or id; no setup action was started.");
}

export function outputLocale(output: Partial<Pick<Output, "json" | "setupLocale">>): SetupLocale {
  return output.json ? "en" : output.setupLocale ?? setupLocale();
}

export function setupText(key: SetupCopyKey, values: Values = {}, locale: SetupLocale = setupLocale()): string {
  return COPY[key][locale === "id" ? 1 : 0].replace(/\{([A-Za-z]+)\}/g, (token: string, name: string) => values[name] === undefined ? token : String(values[name]));
}

export function setupWords(output: Partial<Pick<Output, "json" | "setupLocale">>, key: SetupCopyKey, values: Values = {}): string {
  return setupText(key, values, outputLocale(output));
}

export function setupLine(output: Pick<Output, "line"> & Partial<Pick<Output, "json" | "setupLocale">>, key: SetupCopyKey, values: Values = {}): void {
  output.line(setupWords(output, key, values));
}

export function setupDuration(output: Pick<Output, "line"> & Partial<Pick<Output, "json" | "setupLocale">>, ms: number): string {
  const minutes = ms >= 120_000;
  return setupWords(output, minutes ? "durationMinutes" : "durationSeconds", { number: Math.round(ms / (minutes ? 60_000 : 1_000)) });
}

/** The error's state/JSON message remains canonical; only terminal presentation has a locale. */
export function setupError(code: ConstructorParameters<typeof RemoteInstanceError>[0], key: SetupCopyKey, values: ErrorValues = {}, options: ConstructorParameters<typeof RemoteInstanceError>[2] = {}): RemoteInstanceError {
  const canonical = typeof values === "function" ? values("en") : values;
  const error = new RemoteInstanceError(code, setupText(key, canonical, "en"), options);
  errorCopy.set(error, { key, values });
  return error;
}

export function setupFailureText(error: Error, locale: SetupLocale): string {
  const copy = errorCopy.get(error);
  if (!copy) return error.message;
  return setupText(copy.key, typeof copy.values === "function" ? copy.values(locale) : copy.values, locale);
}

export function affirmative(answer: string, locale: SetupLocale): boolean {
  return (locale === "id" ? /^(?:y|yes|ya)$/i : /^y(es)?$/i).test(answer.trim());
}
