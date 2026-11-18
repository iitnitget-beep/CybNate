const assert = require('assert');
const P = require('../app/src/main/assets/www/planner.js');
const base = () => ({ plan_id:'p1', request_id:'r1', user_goal:'Build a notes app', project_context:{project_type:'web',summary:'Existing app',files:['src/App.js']}, assumptions:[], risks:[], overall_status:'READY', steps:[
 {step_id:'inspect',title:'Inspect files',description:'Read project',assigned_agent:'explorer',required_tools:['list_files','read_file'],input:'Inspect',expected_output:'Find entry points',dependencies:[],affected_files:['src/App.js'],risk_level:'low',verification_criteria:['Files were read'],status:'PENDING'},
 {step_id:'implement',title:'Implement notes',description:'Build feature',assigned_agent:'coder',required_tools:['write_file','edit_file'],input:'Implement',expected_output:'Working feature',dependencies:['inspect'],affected_files:['src/App.js'],risk_level:'medium',verification_criteria:['Tests pass'],status:'PENDING'},
 {step_id:'test',title:'Test feature',description:'Run tests',assigned_agent:'basher',required_tools:['run_terminal_command'],input:'Run tests',expected_output:'Passing tests',dependencies:['implement'],affected_files:['tests/app.test.js'],risk_level:'low',verification_criteria:['Exit code 0'],status:'PENDING'}
]});
const expectCode=(fn, code)=>assert.throws(fn,e=>e.code===code);
(() => {
 let p=P.validatePlan(base()); assert.deepStrictEqual(p.execution_order,['inspect','implement','test']);
 assert.strictEqual(p.steps.length,3); assert.strictEqual(p.request_id,'r1');
 assert.strictEqual(P.parsePlan('```json\n'+JSON.stringify(base())+'\n```').steps.length,3);
 expectCode(()=>P.parsePlan('not json'),'malformed_json');
 expectCode(()=>P.validatePlan(null),'invalid_plan');
 let x=base(); x.steps[1].step_id='inspect'; expectCode(()=>P.validatePlan(x),'duplicate_step');
 x=base(); x.steps[1].dependencies=['missing']; expectCode(()=>P.validatePlan(x),'missing_dependency');
 x=base(); x.steps[0].dependencies=['test']; expectCode(()=>P.validatePlan(x),'dependency_cycle');
 x=base(); x.steps[0].dependencies=['inspect']; expectCode(()=>P.validatePlan(x),'dependency_cycle');
 x=base(); x.steps[0].assigned_agent='root'; expectCode(()=>P.validatePlan(x),'unknown_agent');
 x=base(); x.steps[0].required_tools=['exec_shell']; expectCode(()=>P.validatePlan(x),'unknown_tool');
 x=base(); x.steps[0].affected_files=['../secret']; expectCode(()=>P.validatePlan(x),'unsafe_path');
 x=base(); x.steps[0].affected_files=['/etc/passwd']; expectCode(()=>P.validatePlan(x),'unsafe_path');
 x=base(); x.steps[0].risk_level='extreme'; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.steps[0].status='DONE'; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.steps=[]; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.steps=Array.from({length:33},(_,i)=>Object.assign({},base().steps[0],{step_id:'s'+i,dependencies:[]})); expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.user_goal=''; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.project_context=[]; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.overall_status='MAGIC'; expectCode(()=>P.validatePlan(x),'invalid_plan');
 x=base(); x.steps[0].required_tools=['read_file']; assert.strictEqual(P.validatePlan(x,{knownTools:['list_files','read_file','write_file','edit_file','run_terminal_command']}).steps.length,3);
 x=base(); expectCode(()=>P.validatePlan(x,{knownAgents:['coder']}),'unknown_agent');
 p=P.validatePlan(base()); P.setStepStatus(p,'inspect','READY'); P.setStepStatus(p,'inspect','RUNNING'); P.setStepStatus(p,'inspect','COMPLETED'); assert.strictEqual(p.steps[0].status,'COMPLETED');
 p=P.validatePlan(base()); P.setStepStatus(p,'inspect','READY'); P.setStepStatus(p,'inspect','RUNNING'); P.setStepStatus(p,'inspect','FAILED'); assert.strictEqual(p.steps[1].status,'BLOCKED');
 p=P.validatePlan(base()); expectCode(()=>P.setStepStatus(p,'inspect','COMPLETED'),'illegal_transition');
 p=P.validatePlan(base()); assert.strictEqual(P.canReplan(p),true); const next=P.applyReplan(p,base()); assert.strictEqual(next.replan_count,1); assert.strictEqual(P.canReplan(next),false);
 expectCode(()=>P.applyReplan(next,base()),'replan_limit');
 assert.ok(P.plannerPrompt('build app',['src/App.js']).includes('ONLY one valid JSON'));
 assert.ok(P.replanPrompt(base(),'tool failed','build app',[]).includes('Failure evidence'));
 assert.deepStrictEqual(P.topologicalSort([{step_id:'b',dependencies:['a']},{step_id:'a',dependencies:[]}]),['a','b']);
 assert.throws(()=>P.topologicalSort([{step_id:'a',dependencies:['b']},{step_id:'b',dependencies:['a']}]),e=>e.code==='dependency_cycle');
 console.log('PLANNER TESTS PASSED (28 cases)');
})();
