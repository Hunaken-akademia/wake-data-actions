import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const source=readFileSync(new URL("../pipeline/check_data_completeness.mjs",import.meta.url),"utf8");
const classify=source.slice(source.indexOf("function classifyRace("),source.indexOf("async function fetchOfficialCancellationKeys"));
const helper=source.slice(source.indexOf("async function fetchOfficialUnformedTrifectas("),source.indexOf("async function scan("));
const setup=async(html, ok=true)=>{
 const context=vm.createContext({
  NO_ORIGINAL_DISPLAY_PLACES:new Set([3]),REQUIRE_AI:false,TARGET_DATE:"2026-10-08",GRACE_MIN:15,
  jstDate:()=>"2026-10-09",postDateTime:()=>new Date("2026-10-08T01:00Z"),
  raceKey:(p,r)=>p+":"+r,mapLimit:async(xs,n,f)=>Promise.all(xs.map(f)),
  fetch:async()=>({ok,text:async()=>html}),AbortSignal,console
 });
 vm.runInContext(classify+helper,context);
 const unformed=await context.fetchOfficialUnformedTrifectas(new Map([["14:5",{place_no:14,race_no:5}]]),new Map([["14:5",new Set([1,2,3,4,5,6])]]),new Map());
 const base={race:{dbRace:true,place_no:14,post_time:"10:27",trifectaUnformed:unformed.has("14:5")},preCount:6,exCount:6,snapshotOk:true,weatherOk:true,aiOk:true,oddsCount:120,oddsRequiredCount:120,resultCount:6,activeResultCount:6,payoutOk:false,now:new Date()};
 return {context,base};
};
test("official unformed trifecta does not generate a false missing payout",async()=>{
 const {context,base}=await setup("<tbody><tr><td>3連単</td><td>不成立</td><td>¥100</td></tr></tbody>");
 assert.equal(context.classifyRace(base).status,"complete");
});
test("a different unformed bet never masks missing trifecta data",async()=>{
 const {context,base}=await setup("<tbody><tr><td>3連単</td><td>1-5-3</td><td>¥1000</td></tr></tbody><tbody><tr><td>3連複</td><td>不成立</td></tr></tbody>");
 assert.equal(context.classifyRace(base).status,"failure");
 assert.ok(context.classifyRace(base).missing.includes("payout"));
});
test("official network failure remains a missing payout",async()=>{
 const {context,base}=await setup("",false);
 assert.equal(context.classifyRace(base).status,"failure");
});
test("unformed trifecta does not hide other missing data",async()=>{
 const {context,base}=await setup("<tbody><tr><td>3連単</td><td>不成立</td></tr></tbody>");
 const r=context.classifyRace({...base,exCount:0});
 assert.equal(r.status,"failure");
 assert.ok(r.missing.includes("exhibition"));
 assert.ok(!r.missing.includes("payout"));
});
