# Findings

- Existing API appends user/assistant messages and emits delta before TTS for enabled turn languages. New greeting should reuse completeReply and preserve that ordering.
- Current speech request forwards model, voice, input, WAV, language only. Explicit sampler settings need config schema + resolved config + runtime request propagation.
- Cache only fixed routed public replies. Each call must still perform authorization/device action and a separate seat upload. Cache full request and endpoint/credentials identity, not seat playback outcomes.
- Existing production evidence: 21k-token cold prefill dominates first greeting; temperature=0 yielded five identical short WAVs; shared audio broker adds ASR queue time. Dynamic voice quality, restart, multiple concurrent TTS and UE remain unverified.
- Existing Chinese hardware formatting may prepend passenger names; named contexts now bypass shared caching. LLM-generated replies always bypass, including dynamic tool results.
- Existing wrong-language test used Hello as its model-bound input; changed it to What can you do? so wrong-language handling remains exercised while exact greetings take the new route.
- Manual stream-reading integration needed explicit connection cleanup to avoid waiting on test HTTP keepalive sockets; assertions and end-to-end greeting/cache flow pass.
- General contextReplayTurns only affects recovery seeding, not resumed Agent transcript. Runtime compression is a separate development stage, not claimed solved here.

## Final verified revision
- Replaced resumed generic Agent inference with bounded compact native requests; baseline about2.3k tokens, 12KiB total/4KiB history, exact greeting bypass.
- Greedy decoding is unsafe for JA/KO; positive sampling with seed42 works. Chinese positive sampling had an ASR first-word difference, so final defaults Chinese0/other tested0.9, single serialized worker, fixed seed.
- Found real gateway response hang from swallowed watcher cancellation; stop flag+100ms cleanup bound reproduced/fixed against installed Starlette; remote27 tests pass.
- Long Markdown reply hit TTS cap; added plain speech rendering and concise spoken LLM replies, real API regression passes.
- Empty status must not be interpreted by the model; Chinese uses actual protocol formatter and empty foreign facts use unavailable response.
- Full315 Cabin tests,20 deployment tests,27 remote gateway tests pass; Node bundles pass.
- Final12-text/10-language pairs, concurrent/restart hashes match; all ASR回读 performed, Korean one-word difference remains listening acceptance.
- Real-model local API8 turns pass, greeting42ms first text/1.406s total, cached7ms/8ms; device/broadcast mocked.
- Production plist/compose hashes match original snapshots;8000/8004 still listen,8005/18004/18005 closed. User updated host to10.88.242.29.
