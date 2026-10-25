let count = 0;
document.querySelector('#counter').addEventListener('click', () => {
  document.querySelector('#count').textContent = String(++count);
});
document.querySelector('#delayed').addEventListener('click', () => {
  setTimeout(() => {
    const button = document.createElement('button');
    button.textContent = '延迟目标';
    button.addEventListener('click', () => {
      button.textContent = '已点击';
    });
    document.querySelector('#dynamic').replaceChildren(button);
  }, 250);
});
let uploadGeneration = 0;
document.querySelector('#files').addEventListener('change', async (event) => {
  document.querySelector('#file-count').textContent = String(event.target.files.length);
  const generation = ++uploadGeneration,
    output = document.querySelector('#file-report');
  const files = [...event.target.files];
  output.dataset.state = 'pending';
  output.textContent = '';
  try {
    if (
      !files.length ||
      files.length > 20 ||
      files.some((file) => !file.size || file.size > 8 * 1024 * 1024)
    )
      throw Error('FIXTURE_FILE_BUDGET');
    const observations = [];
    for (const file of files) {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      if (generation !== uploadGeneration) return;
      observations.push({
        name: file.name,
        bytes: file.size,
        digest: [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join(''),
      });
    }
    if (generation !== uploadGeneration) return;
    output.textContent = JSON.stringify({ version: 1, generation, files: observations });
    output.dataset.state = 'ready';
  } catch (error) {
    if (generation !== uploadGeneration) return;
    output.textContent = error instanceof Error ? error.message : 'FIXTURE_FILE_READ_FAILED';
    output.dataset.state = 'failed';
  }
});
