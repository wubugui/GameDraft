/**
 * OpenAI Images Edits API — GPT-Image-1（透明背景）
 */

export async function editImage({ apiKey, prompt, imageFile }) {
  const key = (apiKey || '').trim();
  if (!key) {
    throw new Error('Missing API key');
  }
  if (!(imageFile instanceof File || imageFile instanceof Blob)) {
    throw new Error('Invalid image type: expected File or Blob');
  }

  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('prompt', prompt);
  formData.append('model', 'gpt-image-1');
  formData.append('n', '1');
  formData.append('size', '1024x1024');
  formData.append('quality', 'low');
  formData.append('background', 'transparent');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: formData,
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const errorData = await response.json();
      message = errorData.error?.message || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const result = await response.json();
  if (!result.data?.[0]?.b64_json) {
    throw new Error('Invalid response format from OpenAI Images API');
  }
  return `data:image/png;base64,${result.data[0].b64_json}`;
}
