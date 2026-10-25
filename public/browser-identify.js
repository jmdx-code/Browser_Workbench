const params = new URL(location.href).searchParams;
document.getElementById('alias').textContent = params.get('alias') || '当前浏览器';
document.getElementById('profile').textContent = params.get('profileId') || '未指定';
document.title = (params.get('alias') || '当前浏览器') + ' · 资料识别';
