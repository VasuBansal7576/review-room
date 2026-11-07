const {test} = require('node:test');
const assert = require('node:assert/strict');
const {markers,transcript,cropBox} = require('../public/review-package');
const at = ms=>new Date(ms).toISOString();
const stroke = (seq,extra={})=>({type:'stroke',at:at(1000+seq),data:{strokeId:'s',seq,kind:'drawing',reviewId:'review',color:'#FF453A',points:[{x:.2,y:.3},{x:.4,y:.5}],...extra}});
test('Shift drawings retain their explicit kind, and Undo removes latest marker',()=>{assert.equal(markers([stroke(1)])[0].kind,'drawing');assert.equal(markers([stroke(1),stroke(2,{undone:true})]).length,0)});
test('focused review produces numbered quoted transcript with honest typed speech status',()=>{const text=transcript({name:'Demo'},[stroke(1),{type:'note',at:at(2000),data:{reviewId:'review',text:'Book a call',source:'typed'}}]);assert.match(text,/#1 \(0:00\) \[drawing\]/);assert.match(text,/#2 .*\[note\] "Book a call"/);assert.match(text,/no recognized speech/);assert.match(text,/not baked/)});
test('recognized speech text stays attached to its drawing and is labelled browser recognition',()=>{const text=transcript({},[stroke(2,{text:'Bigger button',source:'speech'})]);assert.match(text,/\[drawing\] "Bigger button"/);assert.match(text,/browser speech recognition/)});
test('crop stays inside the captured frame including edge markers',()=>{for(const points of [[{x:0,y:0}],[{x:1,y:1}],[{x:.2,y:.2},{x:.8,y:.9}]]){const c=cropBox(points,1440,900);assert.ok(c.x>=0&&c.y>=0);assert.ok(c.x+c.width<=1440);assert.ok(c.y+c.height<=900);assert.ok(c.width>0&&c.height>0)}});
