// One combined fake-only SDK/proxy check; optional real-browser journey with CHROME set.
// NODE_ENV=test blocks adjacent secrets and external provider traffic.
import assert from "node:assert/strict";
import http from "node:http";
import { startChrome, startServer } from "./browser-kit.mjs";
import { costMicro } from "../auth.mjs";
import { openAccounts } from "../accounts.mjs";
import { BUTTONS, MVP_QUERY_KINDS, TASKS, decodeProviderOutput, providerSchema } from "../public/js/lib/assistant-tasks.js";
import { PDFDocument } from "pdf-lib";
const started = Date.now();
let calls = 0, failure = null, reply, last, browser, stopReason = "end_turn";
const usage = { input_tokens: 10000, output_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } };
function schemaCounts(schema) {
  let optional = 0, unions = 0, closed = true;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (Array.isArray(node.type) || Array.isArray(node.anyOf)) unions++;
    if (node.properties) optional += Object.keys(node.properties).filter(k => !node.required?.includes(k)).length;
    if (node.type === "object" || Array.isArray(node.type) && node.type.includes("object")) closed &&= node.additionalProperties === false;
    Object.values(node).forEach(visit);
  }
  visit(schema); return { optional, unions, closed };
}
const provider = http.createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  last = JSON.parse(raw); calls++;
  res.setHeader("Content-Type", "application/json");
  const schema = last.output_config?.format?.schema, counts = schemaCounts(schema);
  if (schema && JSON.stringify(schema).includes('"enum"')) { res.writeHead(400); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "AI_REQUEST_FORMAT_INVALID_SCHEMA enum" } })); }
  if (!schema || !counts.closed || counts.optional > 24 || counts.unions > 16) { res.writeHead(400); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Fixture rejected structured output schema" } })); }
  if (failure) { res.writeHead(failure.status); return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: failure.message + " PRIVATE_PROVIDER_DETAIL fake-provider-address@example.test" } })); }
  const output = reply ?? (schema.properties.complete ? { actions: [], text: null, complete: true } : { intent: "smalltalk", requests: [], actions: [], topic: null, text: "Hello." });
  // 5.5 may put thinking before text; the proxy must select by block type, not position.
  res.end(JSON.stringify({ id: "fixture", type: "message", role: "assistant", model: last.model, content: [{ type: "thinking", thinking: "", signature: "fixture" }, { type: "text", text: JSON.stringify(output) }], stop_reason: stopReason, stop_sequence: null, usage }));
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const server = await startServer({ HOST: "127.0.0.1", AUTH: "off", ANTHROPIC_LOG: "debug", ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, AI_MODEL_CHEAP: "old-cheap-override", AI_MODEL_STRONG: "old-heavy-override" });
const post = async body => { const r = await fetch(new URL("api/ai", server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
try {
  const status = await (await fetch(new URL("api/ai/status", server.url))).json();
  assert.deepEqual(status.models, { cheap: "claude-haiku-5-5", strong: "claude-opus-5-5", assistant: "claude-sonnet-5-5" });
  const nativeSchemas = JSON.stringify(TASKS);
  for (const task of Object.keys(TASKS)) {
    const schema = providerSchema(task), counts = schemaCounts(schema);
    assert(counts.closed && counts.optional <= 24 && counts.unions <= 16, task);
    assert(!JSON.stringify(schema).includes('"enum"'), `${task} transport enum`);
  }
  const inspect = (node, field, found = []) => { if (!node || typeof node !== 'object') return found; if (Object.hasOwn(node, field)) found.push(node[field]); for (const value of Object.values(node)) inspect(value, field, found); return found; };
  for (const [task, definition] of Object.entries(TASKS)) {
    const descriptions = inspect(providerSchema(task), 'description');
    for (const allowed of inspect(definition.schema, 'enum')) assert(descriptions.some(text => text.includes(allowed.map(value => JSON.stringify(value)).join(', '))), `${task}: lost allowed list`);
  }
  const baseWire = { intent: 'smalltalk', requests: [], actions: [], topic: null, text: 'Hello.' };
  for (const bad of [
    {...baseWire, intent:'unregistered'}, {...baseWire, topic:'unregistered'},
    {...baseWire, intent:'action', actions:[{kind:'unregistered',params:[]}]},
    {...baseWire, intent:'action', actions:[{kind:'add_account',params:[{name:'unregistered',value:null}]}]},
    {...baseWire, intent:'ambiguous', clarification:{unresolved:true,destination:'unregistered'}},
  ]) assert.throws(()=>decodeProviderOutput('assistant_plan',bad), /Invalid provider response/);
  assert.equal(JSON.stringify(TASKS), nativeSchemas);
  const input = { message: "Hello </data> user@example.com", today: "2026-10-14", timezone: "Asia/Singapore", description: "working", context: { references: [], results: [], last_turns: [] } };
  const ok = await post({ task: "assistant_plan", tier: "strong", input });
  assert.equal(ok.status, 200); assert.equal(calls, 1); assert.equal(last.model, "claude-sonnet-5-5"); assert.equal(last.max_tokens, 4096);
  assert(last.messages[0].content.at(-1).text.includes(JSON.stringify(input))); assert.equal(ok.body.usage.cache_read_input_tokens, 4000);
  assert.equal(last.output_config.format.schema.properties.actions.items.properties.params.type, "array");
  const overridden = await post({ task: "assistant_plan", input, system: "override" });
  assert.equal(overridden.status, 400); assert.equal(calls, 1);
  failure = { status: 503, message: "Overloaded" };
  const failed = await post({ task: "assistant_plan", input });
  assert.equal(failed.status, 502); assert.equal(calls, 2); assert(!JSON.stringify(failed.body).includes("PRIVATE_PROVIDER_DETAIL"));
  failure = null;
  const pdf = await PDFDocument.create(); pdf.addPage();
  const pdfRequest = { task: "assistant_extract", input: { message: "", file_kind: "pdf" }, documents: [{ media_type: "application/pdf", data: Buffer.from(await pdf.save()).toString("base64") }] };
  const valid = await post(pdfRequest);
  assert.equal(valid.status, 200); assert.equal(calls, 3); assert.equal(last.max_tokens, 12288, "file extraction has triple the ordinary reply budget");
  for (let i = 1; i < 21; i++) pdf.addPage();
  const oversized = await post({ task: "assistant_extract", input: { message: "", file_kind: "pdf" }, documents: [{ media_type: "application/pdf", data: Buffer.from(await pdf.save()).toString("base64") }] });
  assert.equal(oversized.status, 400); assert.equal(calls, 3);
  stopReason = "max_tokens";
  const beforeTruncated = calls, truncated = await post(pdfRequest);
  assert.equal(truncated.status, 502); assert.equal(truncated.body.code, "AI_SCHEMA");
  assert(!Object.hasOwn(truncated.body, "output"), "unfinished extraction cannot become a reviewed result");
  assert.equal(calls, beforeTruncated + 1, "unfinished extraction has no hidden retry");
  assert.equal(last.max_tokens, 12288);
  stopReason = "end_turn";

  // Only MVP reads cross the planner boundary. Retained helper registrations are not chat authority.
  reply = {intent:'question',requests:MVP_QUERY_KINDS.map(kind=>({kind,params:[]})),actions:[],topic:null,text:null};
  const allowed = await post({task:'assistant_plan',input});
  assert.equal(allowed.status,200);assert.deepEqual(allowed.body.output.requests,MVP_QUERY_KINDS.map(kind=>({kind,params:{}})));
  for (const [kind,spec] of Object.entries(BUTTONS)) {
    if (MVP_QUERY_KINDS.includes(kind)) continue;
    const operation={kind,params:kind==='set_savings_target'?[{name:'percent_text',value:'20'}]:[]};
    const blocked={intent:spec.type==='query'?'question':'action',requests:spec.type==='query'?[operation]:[],actions:spec.type==='action'?[operation]:[],topic:null,text:null};
    assert.throws(()=>decodeProviderOutput('assistant_plan',blocked),/Invalid provider response/);
  }
  const draft = { intent: "action", requests: [], actions: [{ kind: "log_transaction", params: [{ name: "amount_text", value: "1.005k" }] }], topic: null, text: null };
  for (const params of [{}, [{ name: "note", value: null }, { name: "note", value: null }], [{ name: "statement_day", value: null }], [{ name: "__proto__", value: null }], [{ name: "note", value: {}, confirmed: true }], [{ name: "note" }], [{ name: "date", value: "2026-02-30" }]]) {
    reply = structuredClone(draft); reply.actions[0].params = params;
    const before = calls, result = await post({ task: "assistant_plan", input });
    assert.equal(result.status, 502); assert.equal(result.body.code, "AI_SCHEMA"); assert.equal(calls, before + 1); assert(!Object.hasOwn(result.body, "output"));
  }
  const nonfinite = structuredClone(draft); nonfinite.actions[0].params[0].value = Infinity;
  assert.throws(() => decodeProviderOutput("assistant_plan", nonfinite));
  reply = { actions: draft.actions, text: null, complete: true };
  const extracted = await post({ task: "assistant_extract", input: { message: "", file_kind: "text", text: "A made-up entry" } });
  assert.equal(extracted.status, 200); assert.equal(extracted.body.output.actions[0].params.amount_text, "1.005k");
  reply = { text: "These are matching recorded figures." };
  assert.equal((await post({ task: "assistant_answer", input })).status, 200);
  reply = { date_col: "date", amount_col: "amount", debit_col: null, credit_col: null, description_col: "description", currency_col: null, reference_col: null, date_format: "YYYY-MM-DD", negative_means: "expense" };
  assert.equal((await post({ task: "assistant_csv_map", input: { header: ["date", "amount", "description"], sample_rows: [["2026-10-14", "-12", "Fixture"]] } })).status, 200);

  // Legacy roles keep structured output; no model switch, beta fallback or JSON-prompt retry.
  const legacySchema = { type: "object", required: ["nested"], properties: { nested: { type: "object", required: ["value"], properties: { value: { type: "number" } } } } };
  reply = { nested: { value: 0 } };
  for (const [tier, model] of [["cheap", "claude-haiku-5-5"], ["strong", "claude-opus-5-5"]]) {
    assert.equal((await post({ task: "fixture_legacy", tier, input: {}, schema: legacySchema })).status, 200);
    assert.equal(last.model, model); assert(schemaCounts(last.output_config.format.schema).closed);
    for (const key of ["betas", "fallbacks", "thinking", "temperature", "top_p", "top_k", "tools", "tool_choice"]) assert(!Object.hasOwn(last, key), key);
  }
  assert(!Object.hasOwn(legacySchema, "additionalProperties"));
  assert.equal((await post({ task: "PRIVATE_USER_TASK", tier: "cheap", input: {}, schema: legacySchema })).status, 200);
  assert(!server.out().includes("PRIVATE_USER_TASK"));
  const formatCases = [
    ["schema is too complex to compile", "AI_REQUEST_FORMAT_COMPLEXITY"],
    ["schema compilation failed: unsupported keyword", "AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA"],
    ["structured output grammar is not supported", "AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA"],
    ["schema compilation failed", "AI_REQUEST_FORMAT_UNKNOWN"],
    ["structured output grammar was rejected", "AI_REQUEST_FORMAT_UNKNOWN"],
    ["invalid schema definition", "AI_REQUEST_FORMAT_INVALID_SCHEMA"],
    ["schema compilation timed out: schema is too complex", "AI_REQUEST_FORMAT_COMPLEXITY"],
    ["too many optional parameters in schema", "AI_REQUEST_FORMAT_OPTIONAL_LIMIT"],
    ["too many union parameters in schema", "AI_REQUEST_FORMAT_UNION_LIMIT"],
    ["unsupported schema keyword: minLength", "AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA"],
    ["unsupported schema type: date", "AI_REQUEST_FORMAT_UNSUPPORTED_SCHEMA"],
    ["invalid schema definition", "AI_REQUEST_FORMAT_INVALID_SCHEMA"],
    ["unsupported output_config request option", "AI_REQUEST_FORMAT_UNSUPPORTED_OPTION"],
    ["structured output format rejected for a private unexplained reason", "AI_REQUEST_FORMAT_UNKNOWN"],
  ];
  for (const [message, diagnostic] of formatCases) {
    failure = { status: 400, message };
    const before = calls, result = await post({ task: "assistant_plan", input });
    assert.equal(result.status, 502); assert.equal(result.body.code, "AI_REQUEST_FORMAT"); assert.equal(result.body.diagnostic, diagnostic); assert.equal(result.body.retryable, false); assert.equal(calls, before + 1);
    assert(!JSON.stringify(result.body).includes("PRIVATE_PROVIDER_DETAIL")); assert(!JSON.stringify(result.body).includes("fake-provider-address"));
    assert(!server.out().includes("PRIVATE_PROVIDER_DETAIL")); assert(!server.out().includes("fake-provider-address"));
  }
  failure = { status: 400, message: "Unsupported schema keyword additionalProperties; fake savings balance 987654 and user@example.invalid" };
  const hinted = await post({ task: "assistant_plan", input });
  assert.deepEqual(hinted.body.mentions, ["additionalProperties"]);
  assert(!JSON.stringify(hinted.body).includes("987654")); assert(!JSON.stringify(hinted.body).includes("user@example.invalid"));
  assert(!server.out().includes("987654")); assert(!server.out().includes("user@example.invalid"));
  failure = { status: 400, message: "structured output format rejected because user@example.invalid has savings 987654" };
  const unhinted = await post({ task: "assistant_plan", input });
  assert(!Object.hasOwn(unhinted.body, "mentions"));
  assert(!JSON.stringify(unhinted.body).includes("987654")); assert(!JSON.stringify(unhinted.body).includes("user@example.invalid"));
  assert(!server.out().includes("987654")); assert(!server.out().includes("user@example.invalid"));
  for (const [status, message, code, retryable] of [[400, "Credit balance is too low", "AI_BILLING", false], [401, "Invalid API key", "AI_ACCESS", false], [404, "Model not found", "AI_MODEL", false], [429, "Too many requests", "AI_RATE_LIMIT", true]]) {
    failure = { status, message };
    const before = calls, result = await post({ task: "assistant_plan", input });
    assert.equal(result.status, 502); assert.equal(result.body.code, code); assert.equal(result.body.retryable, retryable); assert.equal(calls, before + 1); assert(!JSON.stringify(result.body).includes("PRIVATE_PROVIDER_DETAIL"));
  }
  failure = { status: 400, message: "Invalid request" };
  const beforeHeavyFailure = calls;
  assert.equal((await post({ task: "fixture_legacy", tier: "strong", input: {}, schema: legacySchema })).status, 502);
  assert.equal(calls, beforeHeavyFailure + 1);
  failure = null; reply = undefined;

  assert.equal(costMicro("claude-sonnet-5-5", usage), 40900);
  assert.equal(costMicro("claude-opus-5-5", usage), 81800);
  assert.equal(costMicro("claude-haiku-5-5", usage), 2065);
  const boundary = { input_tokens: 99998, output_tokens: 10, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 };
  assert.equal(costMicro("claude-haiku-5-5", boundary), 10005);
  assert.equal(costMicro("claude-haiku-5-5", { ...boundary, input_tokens: 99999 }), 50026);
  assert.equal(costMicro("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0 }), 0);
  assert.equal(costMicro("claude-haiku-5-5", { input_tokens: 1, output_tokens: 0 }), 1);
  assert.equal(costMicro("claude-haiku-4-5", usage), 20650);
  assert.equal(costMicro("claude-opus-5", usage), 103250);
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "unknown", "__proto__"]) assert.equal(costMicro(model, null), null);
  assert.equal(costMicro("__proto__", usage), null);
  for (const invalid of [{ ...usage, input_tokens: -1 }, { ...usage, output_tokens: NaN }, { ...usage, cache_creation: { ephemeral_5m_input_tokens: 1 } }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_read_input_tokens: 1 }, {}]) assert.equal(costMicro("claude-haiku-5-5", invalid), null);
  const db = openAccounts(":memory:");
  const fixture = db.create("fixture@example.test");
  db.usage.add(fixture.id, "2026-10", 40900); db.usage.add(fixture.id, "2026-10", null);
  assert.deepEqual({ ...db.usage.get(fixture.id, "2026-10") }, { cost_micro: 40900, calls: 2, unknown_calls: 1 }); db.close();

  if (process.env.CHROME) {
    browser = await startChrome({ width: 420, height: 900 });
    // A module-document has no app head: install the same real icon/styles before favicon discovery.
    await browser.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener('DOMContentLoaded',()=>{const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';document.head.append(viewport);for(const [rel,href] of [['icon','/icon.svg'],['stylesheet','/app.css']]){const link=document.createElement('link');link.rel=rel;link.href=href;document.head.append(link);}},{once:true});` });
    await browser.cmd("Page.navigate", { url: server.url + "js/lib/store.js" });
    await browser.waitFor("document.readyState==='complete'");
    // The isolated module-page fixture must still use the real app's root API base.
    await browser.js("window.history.replaceState(null, '', '/')");
    assert.equal(await browser.js("new URL('api/ai/status', location.href).pathname"), "/api/ai/status");
    await browser.js(`(async()=>{
      const {store}=await import('/js/lib/store.js'),{session}=await import('/js/lib/session.js'),AI=await import('/js/lib/ai.js'),Chat=await import('/js/features/assistant.js');
      store.open(null,async()=>{},'fixture-proxy-browser');session.mode='demo';store.insert('profile',{base_currency:'USD',timezone:'UTC',consent:{ai_provider:true}});store.insert('budget_settings',{start_day:1});
      document.body.innerHTML='<main id="app"></main><div id="modal-root"></div><div id="toast-root"></div>';await AI.refreshStatus();
      let dispose;const draw=()=>{dispose?.({reason:'redraw'});const page=Chat.createChatPage({redraw:draw});document.getElementById('app').innerHTML=page.html;dispose=page.bind(document.getElementById('app'));};draw();
      const form=document.querySelector('[data-chat-form]');form.elements.text.value='Hello';await form.onsubmit({preventDefault(){}});
    })()`);
    assert.deepEqual(await browser.js("({aiLabel: document.querySelector('.msg.assistant .ai-made')?.textContent, text: document.querySelector('.msg.assistant p')?.textContent, error: document.querySelector('[role=alert]')?.textContent || null})"), { aiLabel: "AI-written reply", text: "Hello.", error: null });
    reply = { intent: "how_to", requests: [], actions: [], topic: "add_account", text: null };
    const reviewed = await browser.js(`(async()=>{
      const {store}=await import('/js/lib/store.js');let form=document.querySelector('[data-chat-form]');form.elements.text.value='Add my made-up cash account';await form.onsubmit({preventDefault(){}});
      if(document.querySelector('[data-draft],input[type=file],[data-modal-form]'))throw new Error('Chat reopened removed draft/upload controls');
      return {count:store.all('accounts').length,directions:document.body.textContent.includes('Accounts → ＋ Account')};
    })()`);
    assert.deepEqual(reviewed, { count: 0, directions: true });
    assert.equal(browser.problems().length, 0, browser.problems().join("\n"));
    await browser.shot("assistant-real-sdk-fake-provider");
    console.log("Browser evidence:", browser.shots, "Hello -> real app/client/SDK -> manual account directions without draft/write; no real provider.");
  }
  assert(!server.out().includes("PRIVATE_PROVIDER_DETAIL"));
  assert(!server.out().includes("user@example.com"), "SDK debug mode must not log request bodies");
  assert(!server.out().includes("sending request"), "SDK diagnostics must stay off even when the environment requests debug logging");
  assert(!server.out().includes("old-cheap-override")); assert(!server.out().includes("old-heavy-override"));
  console.log(`PASS combined fake SDK/proxy/schema/decoder/models/pricing/PDF check (${Math.round((Date.now() - started) / 1000)}s runtime; preparation recorded separately). No real provider/user data.`);
} finally { browser?.close(); server.stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
