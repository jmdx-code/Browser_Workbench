let count = 0;
document.querySelector('#frame-button').addEventListener('click', () => {
  document.querySelector('#frame-count').textContent = String(++count);
});
