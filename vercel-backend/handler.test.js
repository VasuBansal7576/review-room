const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const handler = require('./handler');
process.env.SUPABASE_URL = 'https://demo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';
process.env.REVIEW_OWNER_PASSWORD = 'a'.repeat(32);
process.env.REVIEW_PUBLIC_ORIGIN = 'https://review.example';
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });
const rows = Object.fromEntries(['rr_rooms','rr_events','rr_sessions','rr_invitations','rr_recordings','rr_pending_switch'].map(name => [name, []]));
let sequence = 0;
let switchMessage;
global.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.origin === 'https://switch.example') { switchMessage=JSON.parse(options.body).content; return new Response(null,{status:200}); }
  if (url.pathname === '/rest/v1/rpc/rr_claim_login_attempt') return Response.json(true);
  if (url.pathname === '/rest/v1/rpc/rr_switch_prepare') { const {token_hash,target_room}=JSON.parse(options.body); rows.rr_pending_switch.push({hash:token_hash,room_id:target_room,expires_at:new Date(Date.now()+900000).toISOString()}); return Response.json(true); }
  if (url.pathname === '/rest/v1/rpc/rr_switch_reply') { const {token_hash,reply_text,event_id}=JSON.parse(options.body); const index=rows.rr_pending_switch.findIndex(r=>r.hash===token_hash && r.expires_at>new Date().toISOString()); if (index<0) return Response.json(false); const [entry]=rows.rr_pending_switch.splice(index,1); rows.rr_events.push({room_id:entry.room_id,id:event_id,seq:++sequence,type:'switch_reply',author:'Switch agent',data:{text:reply_text},at:new Date().toISOString(),transient:false}); return Response.json(true); }
  if (url.pathname === '/rest/v1/rpc/rr_reserve_recording') { const {new_id,new_room}=JSON.parse(options.body); if (rows.rr_recordings.length>=20 || rows.rr_recordings.filter(r=>r.room_id===new_room).length>=5) return Response.json(false); rows.rr_recordings.push({id:new_id,room_id:new_room,state:'pending',created_at:new Date().toISOString()}); return Response.json(true); }
  if (url.pathname === '/rest/v1/rpc/rr_delete_recording') { const {target_id,target_room,event_id}=JSON.parse(options.body); const rec=rows.rr_recordings.find(r=>r.id===target_id && r.room_id===target_room && ['pending','active'].includes(r.state)); if (!rec) return Response.json(false); rec.state='deleted'; rows.rr_events.push({room_id:target_room,id:event_id,seq:++sequence,type:'recording_deleted',author:'Owner',data:{url:`/recordings/${target_room}/${target_id}`},at:new Date().toISOString(),transient:false}); return Response.json(true); }
  if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) return Response.json({url:url.pathname.replace('/storage/v1','')+'?token=test'});
  if (url.pathname.startsWith('/storage/v1/object/info/')) return Response.json({size: 42});
  if (url.pathname.startsWith('/storage/v1/object/sign/')) return Response.json({signedURL:url.pathname.replace('/storage/v1','')+'?token=test'});
  if (url.pathname === '/storage/v1/object/review-room-recordings' && options.method === 'DELETE') return Response.json([]);
  const name = url.pathname.split('/').at(-1), store = rows[name];
  if (!store) return Response.json({}, {status:404});
  const matches = row => [...url.searchParams].every(([key,value]) => {
    if (['select','limit','order'].includes(key)) return true;
    const [op, ...parts] = value.split('.'); const target = parts.join('.');
    if (op === 'eq') return String(row[key]) === target;
    if (op === 'gt') return key.endsWith('_at') ? row[key] > target : Number(row[key]) > Number(target);
    if (op === 'lt') return key.endsWith('_at') ? row[key] < target : Number(row[key]) < Number(target);
    if (op === 'lte') return Number(row[key]) <= Number(target);
    if (op === 'in') return target.slice(1,-1).split(',').includes(String(row[key]));
    return false;
  });
  if (options.method === 'POST') { const row=JSON.parse(options.body); if (name==='rr_events') { const cost=e=>Buffer.byteLength(JSON.stringify(e.data))+6*Buffer.byteLength(e.author)+512; if (!row.transient && store.filter(e=>e.room_id===row.room_id&&!e.transient).reduce((sum,e)=>sum+cost(e),cost(row))>3*1024*1024) return Response.json({message:'review_room_event_limit'},{status:400}); if (row.type==='recording') { const rec=rows.rr_recordings.find(r=>r.room_id===row.room_id && ['pending','active'].includes(r.state) && row.data.url===`/recordings/${row.room_id}/${r.id}`); if (!rec) return Response.json({message:'review_room_recording_missing'},{status:400}); rec.state='active'; } row.seq=++sequence; row.at=new Date().toISOString();} if (name==='rr_rooms') row.created_at ||= new Date().toISOString(); store.push(row); return Response.json([row]); }
  if (options.method === 'PATCH') { const changed=store.filter(matches); for (const row of changed) Object.assign(row,JSON.parse(options.body)); return Response.json(changed); }
  if (options.method === 'DELETE') { for (let i=store.length-1;i>=0;i--) if (matches(store[i])) store.splice(i,1); return Response.json([]); }
  let found=store.filter(matches); if (url.searchParams.get('order')==='seq.desc') found=found.slice().reverse();
  const limit=Number(url.searchParams.get('limit')) || found.length; return Response.json(found.slice(0,limit));
};
async function invoke(method,path,body,cookie) {
  const req = new EventEmitter(); Object.assign(req,{method,url:path,headers:{origin:'https://review.example',...(cookie ? {cookie} : {})},body});
  const res = { headers:{}, setHeader(k,v){this.headers[k]=v;}, writeHead(s,h){this.statusCode=s; Object.assign(this.headers,h);}, end(v){this.payload=v;} };
  await handler(req,res);
  return {status:res.statusCode,headers:res.headers,body:res.payload ? JSON.parse(res.payload) : null};
}
test('owner, invitation, signed upload, recording and revocation',async()=>{
  assert.equal((await invoke('GET','/api/rooms')).status,401);
  assert.equal((await invoke('POST','/api/owner/session',{password:'wrong'})).status,401);
  const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}); assert.equal(login.status,200);
  const owner=login.headers['Set-Cookie'].split(';')[0];
  const create=await invoke('POST','/api/rooms',{name:'Design',url:'https://example.com'},owner); assert.equal(create.status,201);
  const room=create.body.id;
  const invitation=await invoke('POST',`/api/rooms/${room}/invitations`,{},owner); assert.equal(invitation.status,201);
  const token=new URL(invitation.body.url).hash.split('=')[1];
  const joined=await invoke('POST',`/api/rooms/${room}/join`,{token}); assert.equal(joined.status,200);
  const guest=joined.headers['Set-Cookie'].split(';')[0];
  const upload=await invoke('POST',`/api/rooms/${room}/recordings/upload-url`,{contentType:'video/webm',size:42},guest); assert.equal(upload.status,201); assert.match(upload.body.uploadUrl,/^https:\/\/demo\.supabase\.co\/storage\/v1\/object\/upload\/sign\//);
  const event=await invoke('POST',`/api/rooms/${room}/events`,{type:'recording',author:'Guest',data:{client:'guest',startedAt:1,endedAt:2,url:upload.body.url}},guest); assert.equal(event.status,201);
  const get=await invoke('GET',`/api/rooms/${room}`,undefined,guest); assert.equal(get.status,200); assert.equal(get.body.events[0].data.url,upload.body.url);
  const playback=await invoke('GET',upload.body.url,undefined,guest); assert.equal(playback.status,302); assert.match(playback.headers.Location,/^https:\/\/demo\.supabase\.co\/storage\/v1\/object\/sign\//);
  assert.equal((await invoke('DELETE',`/api/rooms/${room}/invitations`,undefined,owner)).status,200);
  assert.equal((await invoke('GET',`/api/rooms/${room}`,undefined,guest)).status,401);
  assert.equal((await invoke('GET',upload.body.url,undefined,guest)).status,401);
});
test('rejects invalid requests and foreign origins',async()=>{
  const req = new EventEmitter(); Object.assign(req,{method:'POST',url:'/api/owner/session',headers:{origin:'https://evil.example'},body:{password:'a'.repeat(32)}});
  const res={setHeader(){},end(v){this.payload=v;}}; await handler(req,res); assert.equal(res.statusCode,403);
  const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}), owner=login.headers['Set-Cookie'].split(';')[0];
  const room=(await invoke('POST','/api/rooms',{name:'Test',url:'https://example.com'},owner)).body.id;
  assert.equal((await invoke('POST',`/api/rooms/${room}/recordings/upload-url`,{contentType:'video/webm',size:60*1024*1024},owner)).status,400);
  assert.equal((await invoke('POST',`/api/rooms/${room}/events`,{type:'switch_reply',author:'Guest',data:{client:'g'}},owner)).status,400);
});
test('event stream forwards events posted after connection', async () => {
  const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}), owner=login.headers['Set-Cookie'].split(';')[0];
  const room=(await invoke('POST','/api/rooms',{name:'Stream',url:'https://example.com'},owner)).body.id;
  const req=new EventEmitter(); Object.assign(req,{method:'GET',url:`/api/rooms/${room}/events?cursor=0`,headers:{cookie:owner}});
  let release; const done=new Promise(resolve=>{release=resolve;});
  const res={headers:{}, chunks:[],setHeader(k,v){this.headers[k]=v;},writeHead(status,h){this.statusCode=status;Object.assign(this.headers,h);},write(chunk){this.chunks.push(chunk);if(chunk.includes('data: ')){req.emit('close');}},end(){release();}};
  const work=handler(req,res);
  while (!res.chunks.length) await new Promise(resolve=>setTimeout(resolve,1));
  const event=await invoke('POST',`/api/rooms/${room}/events`,{type:'note',author:'Owner',data:{client:'owner',text:'Move this title'}},owner);
  assert.equal(event.status,201); await done; await work;
  assert.match(res.chunks.join(''),/Move this title/);
});
test('reservations cap each room and the whole instance, and deleted slots remain held until safe cleanup', async () => {
  rows.rr_recordings.splice(0);
  const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}), owner=login.headers['Set-Cookie'].split(';')[0];
  const room1=(await invoke('POST','/api/rooms',{name:'One',url:'https://example.com'},owner)).body.id;
  const room2=(await invoke('POST','/api/rooms',{name:'Two',url:'https://example.com'},owner)).body.id;
  const start=room=>invoke('POST',`/api/rooms/${room}/recordings/upload-url`,{contentType:'video/webm',size:42},owner);
  const first=await Promise.all(Array.from({length:6},()=>start(room1)));
  assert.equal(first.filter(r=>r.status===201).length,5);
  assert.equal(first.filter(r=>r.status===413).length,1);
  const moreRooms=[room2];
  for (const name of ['Three','Four','Five']) moreRooms.push((await invoke('POST','/api/rooms',{name,url:'https://example.com'},owner)).body.id);
  for (const room of moreRooms.slice(0,3)) {
    const next=await Promise.all(Array.from({length:5},()=>start(room)));
    assert.equal(next.filter(r=>r.status===201).length,5);
  }
  assert.equal((await start(moreRooms[3])).status,413);
  const rec=first.find(r=>r.status===201).body.url;
  assert.equal((await invoke('DELETE',rec,undefined,owner)).status,200);
  assert.equal((await start(room1)).status,413);
  const old=rows.rr_recordings.find(r=>r.state==='deleted'); old.created_at=new Date(Date.now()-4*60*60*1000).toISOString();
  assert.equal((await start(room1)).status,201);
  assert.equal(rows.rr_recordings.length,20);
});
test('room byte limit produces a useful failure without storing the new event', async () => {
  const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}), owner=login.headers['Set-Cookie'].split(';')[0];
  const room=(await invoke('POST','/api/rooms',{name:'Full',url:'https://example.com'},owner)).body.id;
  rows.rr_events.push({room_id:room,id:'f'.repeat(32),seq:++sequence,type:'note',author:'Owner',data:{client:'x',text:'x'.repeat(3*1024*1024)},at:new Date().toISOString(),transient:false});
  const before=rows.rr_events.length;
  const result=await invoke('POST',`/api/rooms/${room}/events`,{type:'note',author:'Owner',data:{client:'owner',text:'Hello'}},owner);
  assert.equal(result.status,413); assert.equal(result.body.error,'Review storage is full'); assert.equal(rows.rr_events.length,before);
});
test('Switch callback persists one reply in the originating room and rejects reuse or expiry', async () => {
  Object.assign(process.env,{SWITCH_DEMO_REPLIES:'1',SWITCH_AGENT_BASE_URL:'https://switch.example',SWITCH_AGENT_ID:'sender',SWITCH_AGENT_API_KEY:'test-key',SWITCH_ROOM_ID:'test-room',SWITCH_HANDOFF_MENTION:'@review-agent'});
  try {
    const login=await invoke('POST','/api/owner/session',{password:'a'.repeat(32)}), owner=login.headers['Set-Cookie'].split(';')[0];
    const room=(await invoke('POST','/api/rooms',{name:'Switch',url:'https://example.com'},owner)).body.id;
    assert.equal((await invoke('GET',`/api/rooms/${room}`,undefined,owner)).body.switchHandoffMention,'@review-agent');
    const send=await invoke('POST',`/api/rooms/${room}/switch-handoff`,{content:'@review-agent\nMove the title'},owner);
    assert.equal(send.status,200);
    const token=/^Review-Room-Reply: ([a-f0-9]{64})\n/.exec(switchMessage)?.[1]; assert.ok(token);
    assert.notEqual(rows.rr_pending_switch.at(-1).hash,token);
    const request=new EventEmitter(); Object.assign(request,{method:'POST',url:'/api/switch-replies',headers:{},body:{token,text:'Move it down'}});
    const result={setHeader(){},end(payload){this.payload=payload;}}; await handler(request,result); assert.equal(result.statusCode,201);
    const read=await invoke('GET',`/api/rooms/${room}`,undefined,owner);
    assert.equal(read.body.events.filter(e=>e.type==='switch_reply' && e.data.text==='Move it down').length,1);
    const again=await invoke('POST','/api/switch-replies',{token,text:'duplicate'}); assert.equal(again.status,404);
    await invoke('POST',`/api/rooms/${room}/switch-handoff`,{content:'Another note'},owner);
    const expired=/^Review-Room-Reply: ([a-f0-9]{64})\n/.exec(switchMessage)[1]; rows.rr_pending_switch.at(-1).expires_at=new Date(Date.now()-1000).toISOString();
    assert.equal((await invoke('POST','/api/switch-replies',{token:expired,text:'too late'})).status,404);
  } finally { for (const name of ['SWITCH_DEMO_REPLIES','SWITCH_AGENT_BASE_URL','SWITCH_AGENT_ID','SWITCH_AGENT_API_KEY','SWITCH_ROOM_ID','SWITCH_HANDOFF_MENTION']) delete process.env[name]; }
});
