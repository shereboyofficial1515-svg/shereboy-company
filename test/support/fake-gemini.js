// A stand-in for Gemini's generateContent endpoint. Answers in Gemini's response shape,
// deterministically, so tests can check what the server does with the AI's output.
// Nothing leaves this process.
const http = require('http');

function startFakeGemini() {
  const state = { calls: [], mode: 'ok', reply: null, escalate: false };
  const answer = (prompt) => {
    if (prompt.startsWith('Analyse this feedback')) {
      const msg = (prompt.split('<<<CUSTOMER MESSAGE')[1] || '').split('CUSTOMER MESSAGE>>>')[0];
      const name = (/Customer name: (.*)/.exec(prompt) || [])[1];
      const positive = /love|great|thank|excellent/i.test(msg);
      const negative = /slow|broken|crash|refund|charged|angry|terrible/i.test(msg);
      return {
        classification: positive ? 'positive_review' : negative ? 'complaint' : /\?/.test(msg) ? 'question' : 'general_enquiry',
        sentiment: positive ? 'positive' : negative ? 'negative' : 'neutral',
        summary: `Customer wrote about: ${msg.trim().slice(0, 60)}`,
        escalate: state.escalate,
        escalation_reason: state.escalate ? 'Complex complaint.' : '',
        follow_up_questions: negative ? ['Which device and browser were you using?', 'When did this first happen?'] : [],
        suggested_reply: state.reply || `Hello ${name && name !== 'not given' ? name.split(' ')[0] : 'there'},\n\nThank you for taking the time to share this with us. Our team has read your message and will look into it carefully. We will contact you if we need any more details.`
      };
    }
    const action = (/^(Write a complete|Write a different|Improve|Make the administrator|Rewrite)/.exec(prompt) || [])[1] || 'Write';
    const ref = (/Reference: (FB-[\w-]+)/.exec(prompt) || [])[1] || '';
    const instruction = (/Administrator's instruction: (.*)/.exec(prompt) || [])[1] || '';
    return { subject: `About your feedback (${ref})`, body: `Hello,\n\n[${action}] ${instruction}\n\nKind regards,\nSHEREBOY TECH LTD Support` };
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (!/^\/v1beta\/models\/[\w.-]+:generateContent$/.test(req.url) || req.method !== 'POST') return send(404, { error: { message: 'not found' } });
      if (!req.headers['x-goog-api-key']) return send(401, { error: { message: 'API key missing' } });
      const body = JSON.parse(raw || '{}');
      const prompt = body.contents && body.contents[0] && body.contents[0].parts[0].text || '';
      state.calls.push({ prompt, system: body.system_instruction && body.system_instruction.parts[0].text });
      if (state.mode === 'fail') return send(503, { error: { code: 503, message: 'The model is overloaded. Internal detail that must not leak.' } });
      send(200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer(prompt)) }] }, finishReason: 'STOP' }] });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } })));
}

module.exports = { startFakeGemini };
