(function () {
  'use strict';

  // Independiente del módulo de la aplicación: también protege si este no carga.
  function removeCredentialsFromAddress() {
    try {
      var url = new URL(window.location.href);
      var sensitive = ['username', 'password', 'usuario', 'contraseña', 'contrasena'];
      var remove = [];
      url.searchParams.forEach(function (_, key) {
        if (sensitive.indexOf(key.toLowerCase()) !== -1) remove.push(key);
      });
      if (remove.length) {
        remove.forEach(function (key) { url.searchParams.delete(key); });
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
      }
    } catch (_) { /* Las barreras HTML siguen activas aunque no se pueda limpiar el historial. */ }
  }

  removeCredentialsFromAddress();
  window.addEventListener('popstate', removeCredentialsFromAddress);
  window.addEventListener('pageshow', removeCredentialsFromAddress);

  // Todos los formularios se procesan con JavaScript; nunca deben navegar.
  document.addEventListener('submit', function (event) {
    if (event.target && event.target.tagName === 'FORM') event.preventDefault();
  }, true);

  window.addEventListener('load', function () {
    if (document.documentElement.getAttribute('data-app-ready') === 'true') return;
    var button = document.getElementById('login-submit');
    if (button) button.disabled = true;
    var status = document.getElementById('login-status');
    if (status) {
      status.textContent = 'No se pudo cargar el acceso. Recarga la página antes de iniciar sesión.';
      status.classList.add('error');
    }
  });
}());
