# دمج الفيديوهات — Video Merger

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel**، مبني بـ **Node.js خالص (CommonJS)** بلا أي إطار عمل أو خطوة بناء.

- **الواجهة**: عربية RTL، ثيم داكن بتدرجات سماوي/بنفسجي، ملف واحد `public/index.html` (HTML + CSS + JS).
- **التخزين**: Turso (libSQL) عبر `@libsql/client` (HTTP) — كل شيء فيها: المهام، أجزاء المصادر، والفيديو الناتج (صفوف Blob بحجم 2MB). لا S3 ولا تخزين خارجي.
- **المعالجة**: `ffmpeg-static` + `ffprobe-static` داخل الدالة نفسها، مع `ensureExecutable` (نسخ إلى `/tmp` بصلاحية 755).

---

## المحتويات
1. [الهيكل](#الهيكل)
2. [التشغيل المحلي](#التشغيل-المحلي)
3. [النشر على Vercel خطوة بخطوة](#النشر-على-vercel-خطوة-بخطوة)
4. [توثيق API الكامل](#توثيق-api-الكامل)
5. [متغيرات البيئة](#متغيرات-البيئة)
6. [الاختبارات](#الاختبارات)
7. [حدود الخطة المجانية](#حدود-الخطة-المجانية)

---

## الهيكل

```
video-merger/
├── api/                        # دوال Vercel Serverless (CommonJS)
│   ├── jobs.js                 # POST /api/jobs — إنشاء مهمة
│   ├── upload.js               # POST /api/upload — رفع أجزاء الملفات
│   ├── config.js               # GET /api/config — الحدود
│   ├── cron.js                 # GET /api/cron — التنظيف اليومي
│   └── jobs/
│       ├── [id].js             # GET/DELETE /api/jobs/<id>
│       └── [id]/
│           ├── process.js      # POST /api/jobs/<id>/process — الدمج المتزامن
│           └── video.js        # GET /api/jobs/<id>/video — البث مع Range
├── lib/                        # المنطق
│   ├── env.js                  # تحميل .env يدويًا
│   ├── config.js               # الحدود من متغيرات البيئة
│   ├── db.js                   # Turso: المخطط + الـ Blobs المقسمة + التنظيف
│   ├── http.js                 # CORS/JSON/أخطاء عربية
│   ├── ffmpeg.js               # ensureExecutable + ffprobe
│   └── merger.js               # محرك الدمج (تنزيل → filter_complex → ترميز → تخزين)
├── public/
│   └── index.html              # واجهة الموقع كاملة (ملف واحد)
├── scripts/
│   ├── test-unit.js            # اختبار وحدات (ffmpeg + Turso)
│   └── test-http.js            # اختبار HTTP كامل ضد خادم التطوير
├── dev-server.js               # خادم تطوير محلي يحاكي Vercel (منفذ 3040)
├── vercel.json                 # maxDuration 300 + cron يومي
├── .env.example                # قالب المتغيرات (بدون قيم حقيقية)
└── package.json
```

---

## التشغيل المحلي

```bash
cd video-merger
npm install

# ضع بيانات Turso في .env (انسخ .env.example)
cp .env.example .env
# ثم عدّل .env وأضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN

npm run dev          # خادم التطوير على http://localhost:3040
```

`dev-server.js` يحاكي بيئة Vercel: يحلل المسارات الديناميكية (`/api/jobs/<id>`) ويضعها في `req.query`، يقدم `public/` كملفات ثابتة، ويحمّل `.env` يدويًا.

---

## النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso والحصول على البيانات

```bash
# تثبيت واجهة Turso
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup          # أو turso auth login

# إنشاء قاعدة
turso db create video-merger

# رابط القاعدة (انسخه في TURSO_DATABASE_URL)
turso db show video-merger --url

# توكن بصلاحية الكتابة (انسخه في TURSO_AUTH_TOKEN)
turso db tokens create video-merger
```

### 2) ربط المشروع بـ Vercel

1. ارفع مجلد `video-merger/` إلى مستودع Git (ملف `.env` مُستثنى تلقائيًا في `.gitignore` — لا ترفعه أبدًا).
2. في لوحة Vercel: **Add New → Project**، واختر المستودع.
3. مهم جدًا: **Root Directory** ضعه على `video-merger` (إن كان داخل مستودع أكبر).
4. قبل الضغط على Deploy افتح **Settings → Environment Variables** وأضف المتغيرين الإلزاميين:

| المتغير | القيمة |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<اسم-القاعدة>-<حساب>.turso.io` |
| `TURSO_AUTH_TOKEN` | التوكن من `turso db tokens create` |

5. اضغط **Deploy**. ملف `vercel.json` يتكفل تلقائيًا بـ `maxDuration: 300` لكل الدوال وجدولة `/api/cron` يوميًا.

### 3) التجربة بعد النشر

```bash
# إنشاء مهمة من رابطين
curl -X POST https://<مشروعك>.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'

# تنفيذ الدمج (متزامن)
curl -X POST https://<مشروعك>.vercel.app/api/jobs/<jobId>/process

# متابعة الحالة / التقدم
curl https://<مشروعك>.vercel.app/api/jobs/<jobId>

# تحميل الناتج
curl -o merged.mp4 "https://<مشروعك>.vercel.app/api/jobs/<jobId>/video?download=1"
```

الواجهة نفسها متاحة على الصفحة الرئيسية وفي قسم «توثيق API» المدمج فيها بأمثلة curl بالدومين الحقيقي.

---

## توثيق API الكامل

عام بالكامل: بلا تسجيل دخول، CORS مفتوح (`*`)، الأخطاء دائمًا بصيغة `{"error":"رسالة عربية"}`.

### `POST /api/jobs` — إنشاء مهمة

الجسم يقبل إما روابط أو وصفًا كاملًا للمصادر:

```json
{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}
```

```json
{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},
            {"kind":"file","name":"clip.mp4","size":1234567,"mime":"video/mp4"}]}
```

**استجابة `201`:**

```json
{"jobId":"lx3k...","status":"queued","statusUrl":"/api/jobs/lx3k...","processUrl":"/api/jobs/lx3k.../process","expiresAt":"2025-01-01T12:00:00.000Z"}
```

وعند وجود مصادر ملفات تُضاف:

```json
{"uploads":[{"seq":1,"name":"clip.mp4","size":1234567,"mime":"video/mp4","chunks":1,"uploadUrl":"/api/upload?job=...&seq=1"}],"uploadChunkBytes":4194304}
```

الأخطاء: `400` مصادر فارغة/رابط تالف/تجاوز عدد المصادر، `413` ملف أكبر من الحد، `405` طريقة غير POST.

### `POST /api/upload?job=<id>&seq=<n>&chunk=<k>` — رفع الأجزاء

- الجسم **ثنائي خالص** (`application/octet-stream`) بحجم ≤ 4MB لكل جزء (حد طلب Vercel ≈ 4.5MB).
- `seq` هو ترتيب المصدر من `uploads[]`، و`chunk` رقم الجزء ابتداءً من 0.

**استجابة `200`:**

```json
{"ok":true,"seq":1,"chunk":0,"receivedBytes":4194304,"expectedBytes":8388608,"expectedChunks":2,"done":false}
```

الأخطاء: `404` مهمة/مصدر غير موجود، `409` المهمة لم تعد في حالة الرفع، `413` جزء أكبر من الحد، `400` معاملات ناقصة أو جسم فارغ.

### `POST /api/jobs/<id>/process` — تنفيذ الدمج (متزامن)

ينزّل/يسحب المصادر ← يوحد الأبعاد ← يرمّز ← يحفظ، ويرجع مباشرة:

**استجابة `200`:**

```json
{"status":"done","videoUrl":"https://<دومين>/api/jobs/<id>/video","downloadUrl":"https://<دومين>/api/jobs/<id>/video?download=1","size":3466678,"duration":20.03,"resolution":"640x360","expiresAt":"..."}
```

- `202` لو المهمة قيد المعالجة فعله: `{"status":"processing","progress":42}`
- `409` لو أجزاء الملفات لم تكتمل، `404` لو المهمة غير موجودة، `413` لتجاوز حدود الحجم/المدة.

ملاحظة: استدعاء المتابعة (`GET /api/jobs/<id>`) يرجع `progress` من 0–100 (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).

### `GET /api/jobs/<id>` — الحالة والتقدم

```json
{"jobId":"...","status":"done","progress":100,"createdAt":"...","expiresAt":"...","sources":[...],"videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"640x360"}
```

الحالات: `queued` → (`uploading`) → `processing` → `done` | `failed`. عند `failed` يوجد حقل `error`.

### `GET /api/jobs/<id>/video` — بث الناتج

- يدعم **Range** كاملًا: `206` + `Content-Range` + `Accept-Ranges: bytes` (يشمل `bytes=-N` واللاحقة)، ويرجع `416` للمدى الخاطئ.
- `?download=1` يجعل `Content-Disposition: attachment`.
- أخطاء: `404` لو المهمة غير موجودة أو لم تكتمل بعد.

### `DELETE /api/jobs/<id>` — حذف فوري شامل

```json
{"deleted":true,"jobId":"..."}
```

يحذف كل صفوف المهمة من الجداول الأربعة (`jobs`, `sources`, `source_chunks`, `output_chunks`) في batch واحد.

### `GET /api/config` — الحدود العامة

```json
{"version":"1.0.0","maxSources":10,"sourceMaxMb":200,"outputMaxMb":150,"maxTotalDurationSec":600,"uploadChunkBytes":4194304,"expireHours":24,"maxResolution":"1920x1080","fps":30,"preset":"medium"}
```

### `GET /api/cron` — التنظيف اليومي

```json
{"deleted":2,"at":"2025-01-01T03:00:00.000Z"}
```

---

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن الكتابة للقاعدة |
| `MAX_SOURCES` | — | `10` | الحد الأقصى لعدد المصادر في المهمة |
| `SOURCE_MAX_MB` | — | `200` | الحد الأقصى لحجم كل مصدر (MB) |
| `OUTPUT_MAX_MB` | — | `150` | الحد الأقصى لحجم الفيديو الناتج (MB) |
| `MAX_TOTAL_DURATION_SEC` | — | `600` | الحد الأقصى للمدة الإجمالية بعد الدمج |
| `FFMPEG_PRESET` | — | `medium` | preset ترميز libx264 (ultrafast…veryslow) |

---

## الاختبارات

```bash
npm run test:unit    # اختبار وحدات: توليد فيديوهين مختلفي الدقة، دمج، دقة/مدة/صوت، Turso sha256، رفع الأجزاء، الحدود، الحذف الشامل
npm run test:http    # اختبار HTTP كامل ضد dev-server: روابط → دمج → Range 206 → مهمة مختلطة → حذف → 404 → JSON تالف → قائمة فارغة
```

> اختبار HTTP ينزّل روابط خارجية حقيقية ويحتاج اتصال إنترنت، وبيانات `.env` صالحة.

---

## محرك الدمج (تفاصيل تقنية)

- **ffprobe لكل مصدر**: الدقة، معدل الإطارات، المدة، وجود صوت.
- **filter_complex موحّد**: `scale` + `pad` إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`.
- **مصدر بلا صوت**: يضاف مدخل `anullsrc` بنفس مدته تلقائيًا بدل فشل الدمج.
- **الترميز**: `libx264` CRF 18 + `aac` 192k/44100Hz + `+faststart` — MP4 يعمل فورًا على الويب.
- **التقدم**: قراءة `out_time_us` من `-progress pipe:1` وتخزينه في القاعدة (0–40 سحب، 40–90 ترميز، 100).
- **`ensureExecutable`**: ثنائيات ffmpeg/ffprobe تُنسخ إلى `/tmp` بصلاحية 755 عند فقد التنفيذ (مشكلة شائعة في الاستضافات).
- **لا نظام ملفات دائم**: كل شيء في `/tmp` ويُنظّف في `finally`.

## التخزين والحذف التلقائي

- كل Blob يُقسّم إلى صفوف **2MB** (حد HTTP في Turso) وتُقرأ بصفحات.
- `expires_at = created_at + 24h`؛ التنظيف كسول عند كل إنشاء/دمج + `/api/cron` يوميًا.
- بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.

---

## حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة | الأثر هنا |
|---|---|---|
| مدة تنفيذ الدالة (Hobby) | **60 ثانية** للدوال العادية — ملف `vercel.json` يطلب 300s وهو متاح على **Pro**؛ على Hobby البث والدمج يجب أن يبقى تحت 60s | دمج فيديوهات قصيرة فقط (الإعدادات الافتراضية تكفي لعدة مقاطع دقيقة واحدة) |
| حجم الطلب للدالة | **≈ 4.5MB** | الرفع من الواجهة يتم بأجزاء ثنائية **4MB** مع إعادة محاولة ×3 |
| حجم قاعدة Turso المجانية | **5GB** تخزين + 500 مليون قراءة صف/شهر | الناتج ≤ 150MB (≈ 75 صف Blob)، ويُحذف تلقائيًا بعد 24 ساعة |
| نطاق زمني للـ Cron | يومي على الأقل | `/api/cron` مجدول `0 3 * * *` |
| `/tmp` في الدالة | ≈ 512MB–1GB | المصادر تُكتب في `/tmp` وتُنظّف بعد كل عملية |

> إذا كنت ستخدم فيديوهات طويلة أو عدد مستخدمين كبيرًا: ارفع خطة Vercel (لـ maxDuration=300) أو خفّض الحدود عبر متغيرات البيئة.
