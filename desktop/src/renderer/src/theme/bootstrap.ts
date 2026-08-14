const cachedTheme = localStorage.getItem('ke-work-theme')
document.documentElement.dataset.theme = cachedTheme === 'dark' ? 'dark' : 'light'
