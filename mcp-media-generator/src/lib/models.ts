/** سجل الموديلات المدمجة — يربط اسم الموديل الموحّد بالمزودين القادرين على خدمته */

export type ProviderId = "kie" | "cometapi";
/** مزودو التوليد + مزود الدمج (خدمة Video Merger — بلا مفاتيح) */
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  /** الاسم الموحّد كما يراه عميل MCP */
  canonical: string;
  /** صيغ بديلة نقبلها من العملاء ونوحّدها */
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  /** اسم الموديل كما يُرسَل لكل مزود */
  providerModel: Record<ProviderId, string>;
  description: string;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6/flare-text-to-image", "gpt-image-2.6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      // الاسم الأساسي بالشرطات كما طلبه المستخدم (الصيغة بالنقاط تُجرَّب تلقائيًا عند الرفض)
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      cometapi: process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image",
    },
    description:
      "GPT Image 2.6 Flare — OpenAI's fast text-to-image model (posters, product shots, clean layouts).",
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      // الاسم الرسمي لدى kie.ai بالشرطات (موثّق رسميًا: grok-imagine-video-1-5-preview)
      kie: process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
      cometapi: process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview",
    },
    description:
      "Grok Imagine Video 1.5 Preview — xAI video model with native synchronized audio (text-to-video & image-to-video).",
  },
];

export function findModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return MODELS.find((m) => m.aliases.some((a) => a.toLowerCase() === n)) ?? null;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

export const PROVIDER_LABELS_ALL: Record<TaskProvider, string> = {
  ...PROVIDER_LABELS,
  merger: "Video Merger",
};

export const PROVIDER_DOCS: Record<ProviderId, string> = {
  kie: "https://docs.kie.ai",
  cometapi: "https://api.cometapi.com",
};
