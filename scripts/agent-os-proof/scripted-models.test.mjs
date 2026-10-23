import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScriptedModels } from './scripted-models.mjs';

const tools = [
 {type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}},
 {type:'function',name:'write_stdin',parameters:{type:'object',properties:{session_id:{type:'integer'},chars:{type:'string'},yield_time_ms:{type:'integer'},max_output_tokens:{type:'integer'}},required:['session_id','chars']}}
];

test('Responses polls a yielded shell session and retains its eventual output', async t => {
 const model=await startScriptedModels({intents:new Map([['echo',{type:'shell',command:'echo konteks-probe-echo-ok'}]])});
 t.after(()=>model.close());
 const input=[{role:'user',content:'KONTEKS-PROBE STEP echo'}];
 const request=async()=>await (await fetch(model.origin+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',stream:false,input,tools})})).json();
 const first=(await request()).output[0];
 assert.equal(first.name,'exec_command');
 input.push(first,{type:'function_call_output',call_id:first.call_id,output:'Chunk ID: 123\nProcess running with session ID 8619\nOutput:\n'});
 const poll=(await request()).output[0];
 assert.equal(poll.name,'write_stdin');
 assert.equal(JSON.parse(poll.arguments).session_id,8619);
 input.push(poll,{type:'function_call_output',call_id:poll.call_id,output:'Process exited with code 0\nOutput:\nkonteks-probe-echo-ok\n'});
 assert.equal((await request()).output[0].type,'message');
 assert.ok(model.toolResults.get('echo').some(text=>text.includes('konteks-probe-echo-ok')));
});

test('Responses bounds polling and never invents completed command output', async t => {
 const model=await startScriptedModels({intents:new Map([['echo',{type:'shell',command:'echo expected'}]])});
 t.after(()=>model.close());
 const input=[{role:'user',content:'KONTEKS-PROBE STEP echo'}];
 const request=async()=>await (await fetch(model.origin+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',stream:false,input,tools})})).json();
 let call=(await request()).output[0];
 for(let i=0;i<12;i++){
  input.push(call,{type:'function_call_output',call_id:call.call_id,output:'Process running with session ID 8619\nOutput:\n'});
  call=(await request()).output[0];
  assert.equal(call.name,'write_stdin');
 }
 input.push(call,{type:'function_call_output',call_id:call.call_id,output:'Process running with session ID 8619\nOutput:\n'});
 assert.equal((await request()).output[0].type,'message');
 assert.ok(model.toolResults.get('echo').every(text=>!text.includes('expected')));
});

test('Chat completions still records one completed tool result', async t => {
 const model=await startScriptedModels({intents:new Map([['echo',{type:'shell',command:'echo done'}]])});
 t.after(()=>model.close());
 const messages=[{role:'user',content:'KONTEKS-PROBE STEP echo'}];
 const request=async()=>await (await fetch(model.origin+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',stream:false,messages,tools:[{type:'function',function:{name:'exec_command',parameters:tools[0].parameters}}]})})).json();
 const answer=(await request()).choices[0].message;
 messages.push(answer,{role:'tool',tool_call_id:answer.tool_calls[0].id,content:'done'});
 assert.equal((await request()).choices[0].message.content,'DONE echo');
 assert.deepEqual(model.toolResults.get('echo'),['done']);
});

test('Anthropic messages still records one completed tool result', async t => {
 const model=await startScriptedModels({intents:new Map([['echo',{type:'shell',command:'echo done'}]])});
 t.after(()=>model.close());
 const messages=[{role:'user',content:'KONTEKS-PROBE STEP echo'}];
 const request=async()=>await (await fetch(model.origin+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',stream:false,messages,tools:[{name:'bash',input_schema:tools[0].parameters}]})})).json();
 const answer=await request();
 messages.push({role:'assistant',content:answer.content},{role:'user',content:[{type:'tool_result',tool_use_id:answer.content[0].id,content:'done'}]});
 assert.equal((await request()).content[0].text,'DONE echo');
 assert.deepEqual(model.toolResults.get('echo'),['done']);
});
