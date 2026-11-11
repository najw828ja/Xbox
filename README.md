# MCP Media Generator + Video Merger

مشروع واحد متكامل جاهز للنشر على Vercel (Next.js):

**خادم MCP لتوليد الوسائط ودمج الفيديوهات** — توليد صور وفيديو بالذكاء الاصطناعي عبر `gpt-image-2-6/flare-text-to-image` و`grok-imagine-video-1-5-preview`، مع محرك دمج فيديوهات مدمج بـ ffmpeg، وتبديل تسلسلي تلقائي بين مفاتيح API، ولوحة إدارة عربية، وصفحة دمج عامة على `/merge.html`.

## الأدوات الخمس على /mcp

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة من وصف نصي (تبديل تلقائي عبر كل المفاتيح) |
| `generate_video` | توليد فيديو بصوت متزامن أصلي (image-to-video اختياري) |
| `merge_videos` | دمج حتى 10 مقاطع بترتيب معطى — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | متابعة أي مهمة كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## قواعد جوهرية

- **لا وسائط توليد تُنزَّل على السيرفر** — روابط النتائج فقط تُخزَّن في Turso (مصادر ونتائج الدمج تُحذف تلقائيًا بعد 24 ساعة).
- **تبديل تسلسلي صارم**: المفاتيح تُجرَّب بترتيب إضافتها (`created_at ASC`)، وعند أي فشل تنتقل المهمة للمفتاح التالي **بنفس `task_id`** وبصمت تام — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الأرصدة أبدًا.
- المفتاح المرفوض (401/403) يُعطَّل تلقائيًا، والمستنزف (402) يبقى في القاعدة ويُعاد تجربته عند شحن رصيده.
- مهمة تفشل على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة 45 ثانية).
- ملفات الدمج تُحذف بعد ~24 ساعة (تنظيف تلقائي عبر Cron يومي).
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`).

## محرك دمج الفيديو (مدمج في المشروع)

محرك ffmpeg كامل داخل المشروع نفسه — لا خدمة خارجية:

- **API عامة** تحت `/api/merge/*`: `POST /api/merge/jobs` (إنشاء مهمة) → `POST /api/merge/jobs/{id}/process` (تنفيذ) → `GET /api/merge/jobs/{id}` (الحالة والتقدم) → `GET /api/merge/jobs/{id}/video` (بث الناتج مع Range 206 و `?download=1`) → `DELETE /api/merge/jobs/{id}`.
- أداة `merge_videos` على `/mcp` تستدعي هذه المسارات داخليًا في نفس التطبيق.
- **واجهة دمج عامة** على `/merge.html`: روابط و/أو رفع ملفات بأجزاء 4MB، تقدم حي، تحميل مباشر، وتوثيق API بأمثلة curl.
- مواصفات الناتج: H.264 + AAC حتى 1080p، CRF 18، حتى 10 مقاطع، 200MB/مصدر، 150MB ناتج، 600 ثانية إجمالية.

## متغيرات البيئة

| المتغير | إلزامي |
|---|---|
| `TURSO_DATABASE_URL` | ✅ |
| `TURSO_AUTH_TOKEN` | ✅ |
| `MERGER_API_BASE` | — (افتراضيًا التطبيق نفسه؛ أضِفه فقط لو فصلت الدمج في تطبيق آخر) |
| `MCP_ACCESS_TOKEN` | — (حماية اختيارية لمسار `/mcp` بـ Bearer token) |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — (تجاوز أسماء الموديلات) |
| `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_DURATION_SEC` / `FFMPEG_PRESET` | — (حدود محرك الدمج) |

## النشر على Vercel (مشروع واحد)

1. اربط المستودع بـ Vercel (Add New → Project) — يُكتشف Next.js تلقائيًا، اترك **Root Directory** فارغًا.
2. أضف `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` في Settings → Environment Variables.
3. Deploy — رابط MCP سيكون `https://<app>.vercel.app/mcp`، لوحة الإدارة على الصفحة الرئيسية، وصفحة الدمج على `/merge.html`.
4. اختياري: Cron يومي للتنظيف مضبوط مسبقًا في `vercel.json` (يحذف مهام الدمج الأقدم من 24 ساعة عبر `/api/merge/cron`).

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

## التشغيل محليًا

```bash
npm install
cp .env.example .env   # ثم املأ متغيري Turso
npm run dev            # http://localhost:3000
```

- لوحة الإدارة: `http://localhost:3000` — صفحة الدمج: `http://localhost:3000/merge.html`
- فحص الجاهزية: `http://localhost:3000/api/health`
