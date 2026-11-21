const assert = require('assert');
const Plugins = require('../app/src/main/assets/www/plugin-registry.js');
const good = { id:'github', name:'GitHub', version:'1.0.0', description:'Repository integration', category:'development', auth:{type:'oauth2',provider:'github'}, permissions:['profile:read','files:read','issues:write'], tools:[{id:'list-repos',name:'List repositories'}] };
assert.deepStrictEqual(Plugins.validate(good), {valid:true,errors:[]});
const clean = Plugins.normalize(good);
assert.strictEqual(clean.id,'github');
assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.permissions));
assert.strictEqual(Plugins.validate({...good,id:'../github'}).valid,false);
assert.strictEqual(Plugins.validate({...good,version:'latest'}).valid,false);
assert.strictEqual(Plugins.validate({...good,permissions:['admin:all']}).valid,false);
assert.strictEqual(Plugins.validate({...good,tools:[{id:'x',name:'X'},{id:'x',name:'Duplicate'}]}).valid,false);
assert.strictEqual(Plugins.validate({...good,auth:{type:'oauth2'}}).valid,false);
const registry=Plugins.createRegistry([good,{...good,id:'drive',name:'Google Drive',auth:{type:'oauth2',provider:'google'}}]);
assert.strictEqual(registry.list().length,2);
assert.strictEqual(registry.get('github').name,'GitHub');
assert.strictEqual(registry.search('google').length,1);
assert.throws(()=>Plugins.createRegistry([good,good]),/Duplicate plugin id/);
assert.throws(()=>Plugins.normalize({...good,permissions:['root'] }),/Invalid plugin manifest/);
/* Day 2 — catalogue, version pins, compatibility, lifecycle states */
const day2 = {...good, publisher:'CybNate', official:true, pinnedVersion:'1.0.0', compatibility:{minAppVersion:'1.0.0', maxAppVersion:'2.0.0'}};
assert.strictEqual(Plugins.validate(day2).valid,true);
const clean2 = Plugins.normalize(day2);
assert.strictEqual(clean2.official,true);
assert.strictEqual(clean2.stable,true);
assert.strictEqual(clean2.pinnedVersion,'1.0.0');
assert.strictEqual(clean2.installState,'available');
assert.strictEqual(clean2.connectionState,'disconnected');
assert.strictEqual(Plugins.validate({...day2,pinnedVersion:'1.0.1'}).valid,false);
assert.strictEqual(Plugins.validate({...day2,version:'1.0.0-beta.1',pinnedVersion:'1.0.0-beta.1'}).valid,false);
assert.strictEqual(Plugins.validate({...day2,compatibility:{minAppVersion:'latest'}}).valid,false);
assert.strictEqual(Plugins.validate({...day2,compatibility:{minAppVersion:'3.0.0',maxAppVersion:'2.0.0'}}).valid,false);
assert.strictEqual(Plugins.validate({...day2,installState:'broken'}).valid,false);
assert.strictEqual(Plugins.validate({...day2,connectionState:'connected'}).valid,false);
const installed = Plugins.applyState(clean2,{installState:'installed'});
assert.strictEqual(installed.installState,'installed');
assert.strictEqual(installed.connectionState,'disconnected');
const connected = Plugins.applyState(installed,{connectionState:'connected'});
assert.strictEqual(connected.connectionState,'connected');
assert.strictEqual(Plugins.checkCompatibility(clean2,'1.5.0').compatible,true);
assert.strictEqual(Plugins.checkCompatibility(clean2,'0.9.0').compatible,false);
assert.strictEqual(Plugins.checkCompatibility(clean2,'2.0.1').compatible,false);
assert.strictEqual(Plugins.compareVersions('1.0.0-beta.1','1.0.0'),-1);
assert.strictEqual(Plugins.isStableVersion('1.0.0-beta.1'),false);
const reg2 = Plugins.createRegistry([
  {...day2,id:'zeta',name:'Zeta',category:'cloud'},
  {...day2,id:'alpha',name:'Alpha',category:'ai'},
  {...day2,id:'mid',name:'Mid',category:'ai',compatibility:{minAppVersion:'9.0.0'}}
]);
assert.deepStrictEqual(reg2.list().map(m=>m.id),['alpha','mid','zeta']);
assert.deepStrictEqual(reg2.byCategory('ai').map(m=>m.id),['alpha','mid']);
assert.deepStrictEqual(reg2.filter({category:'ai',official:true}).map(m=>m.id),['alpha','mid']);
assert.deepStrictEqual(reg2.compatibleWith('1.5.0').map(m=>m.id),['alpha','zeta']);
assert.deepStrictEqual(reg2.catalogue().map(m=>m.id),['alpha','mid','zeta']);
assert.strictEqual(reg2.catalogue()[0].pinnedVersion,'1.0.0');
assert.throws(()=>Plugins.createRegistry([day2],{appVersion:'0.9.0'}),/Incompatible plugin/);
console.log('Plugin registry tests passed');
