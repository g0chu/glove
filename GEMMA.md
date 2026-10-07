# Gemma 4 compatibility audit

Audited on 2026-10-06 for Gemma 4 31B instruction-tuned QAT served through an
OpenAI-compatible Chat Completions endpoint. This is an application integration
audit, not verification of a running model server. Training, weight conversion,
hardware provisioning, and native Gemini API applications belong to other layers.

## Select the profile

`MODEL_COMPATIBILITY=auto` recognizes Gemma 4 names, including QAT/GGUF filenames.
If the server model alias is `local`, set `MODEL_COMPATIBILITY=gemma4` explicitly.
`generic` disables model-specific transformations. Existing `.env` files are not
modified automatically.

The profile applies centrally to replies, tool rounds, chime decisions, validation
retries, and compaction requests. Stored conversations, original responses, and
attachment bytes remain in the durable archive. Only the outgoing request view
omits completed-turn reasoning and reorders image parts.

## Coverage

| Area | Glove behavior / remaining responsibility | Source |
| --- | --- | --- |
| Roles and native tokens | Sends `system`, `user`, `assistant`, and `tool` API messages. The server's model-specific template supplies native turn, tool, and string-delimiter tokens. Do not use the older Gemma 3 template for Gemma 4. | [Google prompt formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4) |
| Thinking in response content | Separates leading `<\|channel>thought ... <channel\|>` blocks into reasoning. Also accepts explicit `<think>`/`<analysis>` wrappers from compatible servers. Works incrementally across split markers and Unicode in SSE, and with JSON responses. | [Google thinking guide](https://ai.google.dev/gemma/docs/capabilities/thinking) |
| Empty or unfinished thinking | Empty blocks produce no answer text. Once a thought block starts, an unfinished block remains reasoning. Unmarked prose cannot safely be identified as thinking; the server must return a reasoning field or complete opening markers. | [Google thinking guide](https://ai.google.dev/gemma/docs/capabilities/thinking) |
| Historical thoughts | Omits completed-turn thoughts from Gemma requests, including marked thinking in legacy assistant text. Keeps current chime/tool thoughts during continuations and interrupted attempts. Generic models keep their existing history behavior. | [Google history rules](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4) |
| Thinking switch | Optional `MODEL_CHAT_TEMPLATE_KWARGS` passes server-supported template controls. `enable_thinking` selects thinking; `preserve_thinking` permits supplied active tool thoughts across interleaved user messages. Defaults remain server-controlled. | [Google canonical template](https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja) |
| Function declarations | Sends explicit JSON schemas with names, descriptions, properties, required arguments, and nested structures where applicable. No dynamic execution of model text. | [Google function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) |
| Function execution | Executes registered functions only, parses JSON arguments, returns errors as paired tool results, preserves call IDs/order, and bounds tool rounds. The endpoint must parse native Gemma tool syntax into API `tool_calls`. | [Google function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) |
| Chime validation | Requires one usable chime call. Invalid outputs retry without a fixed limit, retaining one replaceable failure reminder. Rejected prose, reasoning, and calls never enter working history; raw archive capture remains available. Transient pre-response connection failures get two delayed retries; other endpoint failures stop. Activity interrupts; overflow uses existing recovery. | Application-specific behavior |
| Sampling | Gemma profile defaults to temperature 1.0, top-p 0.95, top-k 64. `MODEL_TEMPERATURE`, `MODEL_TOP_P`, and `MODEL_TOP_K` override them. `MODEL_TOP_K=endpoint` omits the nonstandard field. Generic profiles omit sampling controls unless configured. | [Google model card](https://ai.google.dev/gemma/docs/core/model_card_4) |
| Image ordering | Places images before text in user messages on the wire; preserves order within each kind and leaves persisted renderings untouched. | [Google modality ordering](https://ai.google.dev/gemma/docs/core/model_card_4) |
| Image preparation | Sends bounded image bytes as `image_url` data URIs. Decoder support and vision encoder/projector loading belong to the server. Byte limits are not visual-token budgets. | [Google vision guide](https://ai.google.dev/gemma/docs/capabilities/vision) |
| Image resolution | Google documents visual budgets 70/140/280/560/1120. Configure the processor/server; these are not portable Chat Completions fields. Glove does not resize images or claim its fixed fallback token estimate is exact. Endpoint usage is preferred. | [Google vision guide](https://ai.google.dev/gemma/docs/capabilities/vision) |
| Context window | Gemma 4 31B supports up to 256K tokens; the actual server slot can be smaller. Glove uses measured usage, optional `/slots` probing, automatic compaction budgets, and overflow recovery rather than assuming 256K is allocated. | [Google model card](https://ai.google.dev/gemma/docs/core/model_card_4) |
| Audio | 31B has no audio encoder. Glove has no audio input pipeline for other variants either. Binary audio is not converted into invented transcripts. | [Google model card](https://ai.google.dev/gemma/docs/core/model_card_4), [audio guide](https://ai.google.dev/gemma/docs/capabilities/audio) |
| Video | Gemma supports video/frame understanding; Glove does not extract frames or send video attachments as video inputs. Frames uploaded individually can use the existing image path. | [Google video guide](https://ai.google.dev/gemma/docs/capabilities/vision/video) |
| PDFs and binary files | Text attachments are inlined when enabled. Glove does not render PDF pages, extract arbitrary binary documents, or imply that raw PDF bytes are vision input. Upload page images or extracted text. | Application input limits |
| QAT and deployment | QAT changes weight preparation, not Glove's HTTP protocol. Load the appropriate artifact for the inference engine. Glove does not download or convert weights. | [Google QAT overview](https://ai.google.dev/gemma/docs/core), [llama.cpp integration](https://ai.google.dev/gemma/docs/integrations/llamacpp) |
| Multi-token prediction | Draft-model loading, speculative decoding, and device settings belong to the server. Glove consumes the resulting Chat Completions stream. Its optional cache-disable flag remains a server-specific troubleshooting control. | [Google MTP overview](https://ai.google.dev/gemma/docs/mtp/overview) |
| Hosted Gemini API | Native `generateContent` request/response shapes, Google Search grounding, and Files API uploads are not implemented here. Use a suitable Chat Completions endpoint/adapter; do not configure a native `generateContent` URL as `MODEL_API_URL`. | [Google hosted API guide](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api) |
| Model limitations | Correct transport does not guarantee factuality, tool decisions, exact object counts, or successful task completion. The bot reports actual tool outcomes and unsent attachments. It does not impose application policies copied from model evaluation/training descriptions. | [Google model card](https://ai.google.dev/gemma/docs/core/model_card_4) |

## Example for a local Gemma server

```dotenv
MODEL_API_URL=http://localhost:8080/v1/chat/completions
MODEL_NAME=local
MODEL_COMPATIBILITY=gemma4
MODEL_TEMPERATURE=1.0
MODEL_TOP_P=0.95
MODEL_TOP_K=64
```

With a server supporting Jinja controls, enable thinking with:

```dotenv
MODEL_CHAT_TEMPLATE_KWARGS='{"enable_thinking":true,"preserve_thinking":true}'
```

Use `enable_thinking:false` to disable it, or leave the variable empty for the
server default. The client does not inject thinking control tokens into the
master prompt, preserving the prompt prefix shared by chime and replies.
The canonical template inserts controls in its first system turn.
[Google canonical template](https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja)

On llama-server, use a current model-compatible Jinja template and native chat
parsing. `--reasoning-format deepseek` returns a separate reasoning field;
`--skip-chat-parsing` exposes raw tools/thoughts and should not be used for this
integration. `chat_template_kwargs` and `top_k` are server extensions: omit
unsupported extensions for strict providers. Configure additional server-side
samplers so they do not unintentionally override the intended sampling behavior.
[llama-server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

`MODEL_ENABLE_IMAGES=true` additionally requires a vision-capable server. Keep
its image processor/token budget configured there. For summaries and overflow,
Glove's fallback size remains an estimate; `/slots` is a llama-server extension,
not a discovery protocol implemented by every provider.

## Verification

`npm test` exercises every thought-marker split position, per-character streams,
Unicode, empty and unfinished thinking, preserved literal examples in final text,
Gemma model-name recognition, configuration validation, real mock-HTTP SSE/JSON,
tool argument normalization, sampling controls, original response byte capture,
image order, and nonmutating outgoing history preparation. Entrypoint tests check
old NO/YES reasoning removal, current decision reasoning retention, tool rounds,
and continuation after an interrupted tool attempt. Generic-model tests remain
in the same suite. `npm run typecheck` checks the source types.

These checks use hermetic mocks. They do not verify the installed server build,
loaded QAT artifact, Jinja template, vision projector, context allocation, or
real Gemma generation quality.
