## T2I Prompt Engineering Guide

### Top 5 Prompt Strategies

1.  **Hyper-Specific, Multi-Sensory Descriptions:** Prompts that describe not just the subject, but also the lighting, texture, pose, and atmosphere in precise detail consistently achieve the highest scores. This strategy reduces ambiguity for the model.
    - **Example:** "A stunning young woman in an opulent 18th-century European ballroom, dressed in an elaborate, satin-embroidered gown of gold and floral patterns... The lighting is soft and ambient, creating a luxurious, cinematic atmosphere..."
    - **Why it works:** Provides a rich, unambiguous target for the model to generate, leading to high prompt adherence and detail.

2.  **Trigger Words + Detailed Scene:** Using a specific LoRA trigger word (e.g., `slider, bodyweight`, `anatomyfix`) followed by a highly detailed scene description yields exceptional results, especially for anatomy and photorealism.
    - **Example:** `anatomyfix, full body shot of a woman in a dramatic ballet arabesque pose on one leg, arms extended with five visible fingers on each hand, visible joint definition in wrists and elbows...`
    - **Why it works:** The trigger word activates a specialized LoRA, while the detailed description guides the model to apply that specialization precisely.

3.  **Structured, Narrative-Style Prompts:** Prompts written in a descriptive, almost narrative style (like a photo caption or scene description) are highly effective, especially for complex scenes. This includes specifying the subject, pose, attire, setting, lighting, and mood.
    - **Example:** "A elegant female ballet dancer in a white tutu and pointe shoes, performing an arabesque pose in a grand theater. Her hair is in a perfect bun... The rich red velvet curtains and ornate gold decorations of the theater create a luxurious backdrop."
    - **Why it works:** This structure provides a logical flow of information, helping the model build a coherent and detailed image from the ground up.

4.  **Explicit Quality Modifiers:** Including specific quality and style keywords at the end of the prompt is a powerful way to steer the output towards photorealism and high fidelity.
    - **Example:** `photorealistic, detailed hands and face, ultra sharp focus`, `hyper-realistic, detailed, and painterly`, `8k uhd`.
    - **Why it works:** These keywords act as a final directive, pushing the model to prioritize texture, sharpness, and realism.

5.  **Leveraging the "Simple" Prompt for Consistency:** For tasks requiring high consistency and clean results (e.g., product shots, simple portraits), a minimal, clear prompt is best.
    - **Example:** "A young woman standing in a simple pose, facing the camera, wearing casual clothes, clean white background, studio lighting, high quality portrait photography."
    - **Why it works:** Reduces the chance of the model introducing unwanted elements or stylistic flourishes, leading to perfect prompt adherence and artifact-free images.

### Prompt Patterns Correlating with High Scores

- **High Prompt Adherence (9-10):**
    - **Pattern:** Prompts that explicitly state the subject, pose, clothing, setting, lighting, and style in a structured, non-contradictory way.
    - **Example:** "A confident young woman with long, straight dark brown hair stands in a poised, full-length pose against a clean, neutral light gray studio background. She wears a bold, asymmetrical two-tone outfit..."
- **High Detail & Sharpness (9-10):**
    - **Pattern:** Prompts that include specific anatomical details (e.g., "visible individual fingers", "detailed irises", "fine pores") and quality modifiers (e.g., "ultra sharp focus", "8k uhd").
    - **Example:** `photorealistic portrait of a young woman, sharp eyes with detailed irises, natural skin texture with fine pores...`
- **High Overall Score (9-10):**
    - **Pattern:** A combination of the above: a specific trigger word or subject, a detailed description of the scene and subject, and explicit quality/style modifiers. The most successful prompts leave little to the imagination.

### Things to Avoid

- **Technical/Command Prompts:** Using prompts like "BFS head face swap" leads to low prompt adherence scores because the model cannot interpret the technical action. Always describe the *desired visual outcome*.
- **Style Mismatch:** Specifying a medium (e.g., "photograph", "cinematic") that the generated image doesn't match (e.g., an AI-generated, painterly look) will result in a low adherence score. Ensure the prompt's style keywords align with the model's capabilities.
- **Contradictory or Ambiguous Details:** Prompts that contain conflicting information (e.g., "only 裙子" but describing a full outfit) confuse the model and reduce adherence.
- **Overly Long, Unstructured Prompts:** While detail is good, a massive wall of text without clear structure can be less effective than a well-organized, narrative-style prompt.

### Best Parameter Combinations per Pipeline

- **flux2-klein (Best for Speed & High Quality):**
    - **Parameters:** Steps: 4, CFG: 5, Size: 640x960, denoise: 0.4
    - **Performance:** ~5.3s, ~15.8GB peak memory.
    - **LoRA Impact:** Using a LoRA (e.g., `klein_slider_bodyweight_50` at 0.5-0.8 scale) can boost detail and sharpness scores from 9 to 10 with minimal performance cost (~0.1s, ~20MB).
    - **Best Use Case:** High-quality, fast generation for portraits, full-body shots, and scenes with specific anatomical or stylistic requirements.

- **zimage (Best for Consistent, High-Fidelity Output):**
    - **Parameters:** Steps: 9, Size: 640x960, denoise: 0.4
    - **Performance:** ~12.3s, ~7.8GB peak memory.
    - **LoRA Impact:** Not tested in this batch, but the base model alone delivers exceptional consistency (9/10 across all metrics).
    - **Best Use Case:** Studio portraits, fashion photography, and scenes requiring high prompt adherence and clean, artifact-free results. The lower memory footprint is a significant advantage.

- **lens (Best for Maximum Detail & Realism):**
    - **Parameters:** Steps: 20, Size: 640x960, denoise: 0.4
    - **Performance:** ~35.5s, ~16.8GB peak memory.
    - **LoRA Impact:** Not tested in this batch.
    - **Best Use Case:** When the absolute highest level of detail and realism is required, and generation time is not a primary concern. The performance cost is 3x-7x higher than other pipelines.

### Top 5 Example Prompts with Explanations

1.  **Prompt:** `anatomyfix, full body shot of a woman in a dramatic ballet arabesque pose on one leg, arms extended with five visible fingers on each hand, visible joint definition in wrists and elbows, torso twisted with clear ribcage and hip alignment, photorealistic, detailed anatomy, ultra sharp focus`
    - **Score:** 10/10
    - **Pipeline:** flux2-klein
    - **Why it worked:** The `anatomyfix` trigger word activates a specialized LoRA, and the prompt provides an exhaustive list of anatomical details (fingers, joints, ribcage). This combination ensures the model focuses on and correctly renders complex human anatomy.

2.  **Prompt:** `slider, bodyweight, full body shot of a woman standing in a narrow cobblestone alley, wearing a flowing red dress, one hand raised to adjust her hair with visible individual fingers, natural afternoon side lighting casting long shadows, photorealistic, detailed hands and face, ultra sharp focus`
    - **Score:** 10/10
    - **Pipeline:** flux2-klein
    - **Why it worked:** Similar to #1, the `slider, bodyweight` trigger word activates a body-focused LoRA. The prompt is a masterclass in specificity: it defines the scene, pose, clothing, lighting, and required detail level, leaving no room for misinterpretation.

3.  **Prompt:** `A young woman standing in a simple pose, facing the camera, wearing casual clothes, clean white background, studio lighting, high quality portrait photography.`
    - **Score:** 10/10
    - **Pipeline:** zimage
    - **Why it worked:** This is the perfect "simple" prompt. It is clear, concise, and non-contradictory. It asks for a straightforward studio portrait and the zimage pipeline delivers it with perfect adherence and zero artifacts. It proves that sometimes less is more.

4.  **Prompt:** `photorealistic portrait of a young woman, sharp eyes with detailed irises, natural skin texture with fine pores, soft studio lighting, bokeh background, high detail, ultra sharp focus`
    - **Score:** 9-10/10
    - **Pipeline:** zimage
    - **Why it worked:** This prompt focuses on the most critical elements of a photorealistic portrait: eyes and skin texture. By explicitly requesting "detailed irises" and "fine pores," it guides the model to generate the high-frequency details that are the hallmark of realism.

5.  **Prompt:** `A stunning young woman in an opulent 18th-century European ballroom, dressed in an elaborate, satin-embroidered gown of gold and floral patterns with lace trim and puffed sleeves... The style is hyper-realistic, detailed, and painterly, evoking the elegance of a Baroque or Rococo court.`
    - **Score:** 9/10
    - **Pipeline:** zimage / lens
    - **Why it worked:** This is a highly detailed, narrative-style prompt that paints a complete picture. It specifies the subject, attire, setting, lighting, and desired style. The rich, descriptive language gives the model a strong, unambiguous target, resulting in a complex, high-fidelity image.