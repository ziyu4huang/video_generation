export interface BuiltinPrompt {
  label: string;
  category: string;
  prompt: string;
}

export const BUILTIN_PROMPTS: BuiltinPrompt[] = [
  // --- Photorealistic ---
  {
    label: "Portrait",
    category: "Photorealistic",
    prompt:
      "photorealistic portrait of a young woman, sharp eyes with detailed irises, natural skin texture with fine pores, soft studio lighting, bokeh background, high detail, ultra sharp focus",
  },
  {
    label: "Full Body",
    category: "Photorealistic",
    prompt:
      "full body shot of a young woman standing confidently, wearing a stylish outfit, natural pose, sharp facial features, detailed hands and fingers, studio lighting with soft shadows, clean background, photorealistic, ultra sharp focus, fashion photography",
  },
  {
    label: "Intimate Portrait",
    category: "Photorealistic",
    prompt:
      "一位年轻女性坐在床上，身穿浅蓝色紧身连体衣，肩部饰有白色蕾丝花边，她侧身回望镜头，眼神温柔而略带羞涩，深色长发自然垂落，额前刘海轻柔地贴在额角，背景是简洁的白色墙面和带有编织纹理的白色床品，床头隐约可见深棕色木质边缘，整体画面构图以人物为中心，采用中景视角，突出人物姿态与服装细节，光线柔和均匀，来自正面偏上方的自然光营造出明亮清新的氛围，光影过渡细腻，皮肤质感真实，色彩饱和度适中，呈现出一种日常生活中温馨私密的场景感，仿佛是用普通相机拍摄的居家写真，具有生活气息和真实感，画面干净纯粹，充满青春与宁静的美感. Keep the presentation in a romantic intimate adult direction. Apply a visual treatment with natural visual continuity, controlled natural lighting, clean readable light, balanced color, clean readable composition, and subtle natural texture. Use 50mm lens and medium shot for visual framing.",
  },
  {
    label: "Cyberpunk Woman",
    category: "Photorealistic",
    prompt:
      "cyberpunk woman with neon hair standing in a rain-soaked alley, holographic advertisements, purple and teal color scheme, dramatic lighting, ultra sharp",
  },
  // --- Anime ---
  {
    label: "Anime Girl",
    category: "Anime",
    prompt:
      "anime-style close-up portrait of a young woman, highly detailed eyes with catchlights, flowing hair, soft cel-shading, pastel color palette, clean line art",
  },
  {
    label: "Anime Warrior",
    category: "Anime",
    prompt:
      "anime girl with silver hair and red eyes, wearing dark armor, holding a katana, determined expression, standing in a misty battlefield, dramatic lighting, anime art style, detailed illustration",
  },
  {
    label: "Anime Cyberpunk",
    category: "Anime",
    prompt:
      "anime girl with short blue hair and cybernetic implants, wearing a neon jacket over a crop top, futuristic city at night, holographic displays, cyberpunk anime art style, cool expression, vibrant neon lighting",
  },
  // --- Scene ---
  {
    label: "Mountain Landscape",
    category: "Scene",
    prompt:
      "photorealistic mountain landscape at golden hour, sharp rocky peaks, detailed pine forest, dramatic sky with clouds, ultra sharp, high dynamic range",
  },
  {
    label: "Tokyo Night",
    category: "Scene",
    prompt:
      "street photography of a busy Tokyo crosswalk at night, neon signs reflected on wet pavement, people with umbrellas, cinematic, ultra sharp",
  },
  {
    label: "Wildlife Fox",
    category: "Scene",
    prompt:
      "wildlife photography of a red fox in golden autumn forest, detailed fur texture, soft bokeh background, natural lighting, ultra sharp focus",
  },
];
