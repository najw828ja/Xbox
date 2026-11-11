# MCP Media Generator + Video Merger

مشروعان متكاملان جاهزان للنشر على Vercel:

1. **خادم MCP لتوليد الوسائط** (جذر المستودع — Next.js): توليد صور وفيديو بالذكاء الاصطناعي عبر `gpt-image-2-6/flare-text-to-image` و`grok-imagine-video-1-5-preview`، مع دمج الفيديوهات، وتبديل تسلسلي تلقائي بين مفاتيح API، ولوحة إدارة عربية.
2. **موقع دمج الفيديوهات** (`video-merger/` — Node.js خالص + Vercel Functions): خدمة دمج مقاطع الفيديو بـ ffmpeg مع API عامة وواجهة عربية — وهي خدمة الدمج التي يعتمد عليها خادم MCP عبر `MERGER_API_BASE`.

## الأدوات الخمس على /mcp

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة من وصف نصي (تبديل تلقائي عبر كل المفاتيح) |
| `generate_video` | توليد فيديو بصوت متزامن أصلي (image-to-video اختياري) |
| `merge_videos` | دمج حتى 10 مقاطع بترتيب معطى — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | متابعة أي مهمة كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## قواعد جوهرية

- **لا وسائط تُنزَّل على السيرفر** — روابط النتائج فقط تُخزَّن في Turso.
- **تبديل تسلسلي صارم**: المفاتيح تُجرَّب بترتيب إضافتها (`created_at ASC`)، وعند أي فشل تنتقل المهمة للمفتاح التالي **بنفس `task_id`** وبصمت تام — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الأرصدة أبدًا.
- المفتاح المرفوض (401/403) يُعطَّل تلقائيًا، والمستنزف (402) يبقى في القاعدة ويُعاد تجربته عند شحن رصيده.
- مهمة تفشل على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة 45 ثانية).
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`).

## متغيرات البيئة

| المتغير | المشروع | إلزامي |
|---|---|---|
| `TURSO_DATABASE_URL` | الاثنان | ✅ |
| `TURSO_AUTH_TOKEN` | الاثنان | ✅ |
| `MERGER_API_BASE` | خادم MCP | — (افتراضي `https://dmg1.vercel.app` — غيّره لدومين موقع الدمج الخاص بك بعد نشره) |
| `MCP_ACCESS_TOKEN` | خادم MCP | — (حماية اختيارية لمسار `/mcp` بـ Bearer token) |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | خادم MCP | — (تجاوز أسماء الموديلات) |
| `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_DURATION_SEC` / `FFMPEG_PRESET` | video-merger | — |

## النشر على Vercel (مشروعان من نفس المستودع)

### المشروع الأول: خادم MCP
1. اربط المستودع بـ Vercel (Add New → Project) — يُكتشف Next.js تلقائيًا، اترك **Root Directory** فارغًا.
2. أضف `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` في Settings → Environment Variables.
3. Deploy — رابط MCP سيكون `https://<app>.vercel.app/mcp`، ولوحة الإدارة على الصفحة الرئيسية.

### المشروع الثاني: موقع دمج الفيديوهات
1. أضف مشروعًا ثانيًا من نفس المستودع، واضبط **Root Directory = `video-merger`**.
2. أضف نفس متغيري Turso.
3. Deploy — ثم انسخ دومينه وضعه في `MERGER_API_BASE` ضمن متغيرات المشروع الأول وأعد نشره.

> رفع ملفات الفيديو من الواجهة يعمل بأجزاء 4MB لتجاوز حد حجم الطلب في Vercel، وتجد التوثيق الكامل للـ API بأمثلة curl في `video-merger/README.md`.

## الربط مع عملاء MCP

```json
{
  "mcpServers": {
    "media-generator": { "url": "https://<app>.vercel.app/mcp" }
  }
}
```

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في Server URL.
- **Claude Desktop**: نفس الصيغة مع `"type": "http"` في `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline**: نفس الصيغة في `mcp.json`.

الفيديو يحتاج دقائق: السيرفر يعيد `task_id` فورًا ويتابعه العميل بـ `get_task` كل 10 ثوانٍ مع بث تقدم حي (Progress notifications).

## التشغيل محليًا (خادم MCP)

```bash
bun install
cp .env.example .env   # ثم املأ متغيري Turso
bun run dev            # http://localhost:3000
```

اختبارات جاهزة في `scripts/` (مثل `bun run scripts/test-key-failover.ts` لاختبار التبديل التسلسلي e2e).

## التشغيل محليًا (موقع الدمج)

```bash
cd video-merger
npm install
cp .env.example .env   # ثم املأ متغيري Turso
node dev-server.js     # http://localhost:3040
npm test               # 55 اختبار وحدات + HTTP
```
