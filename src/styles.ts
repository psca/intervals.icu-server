export const PAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.5; color: #111;
    background: #f5f5f7; min-height: 100vh;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 48px 16px;
  }
  .card {
    background: #fff; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 16px rgba(0,0,0,.06);
    padding: 36px 40px; width: 100%; max-width: 440px;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 600; color: #c0392b; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
  .hint { color: #888; font-weight: 400; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 5px; color: #333; }
  input[type=text], input[type=password] {
    width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px;
    font-size: 14px; font-family: inherit; outline: none; transition: border-color .15s;
  }
  input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
  .btn-primary {
    margin-top: 8px; padding: 9px 18px; background: #2563eb; color: #fff;
    border: none; border-radius: 6px; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-danger {
    padding: 8px 16px; background: #fff; color: #dc2626;
    border: 1px solid #dc2626; border-radius: 6px; font-size: 14px;
    font-weight: 500; cursor: pointer; transition: background .15s, color .15s;
  }
  .btn-danger:hover { background: #dc2626; color: #fff; }
  .danger-zone {
    margin-top: 32px; padding-top: 24px; border-top: 1px solid #f0f0f0;
  }
  .danger-zone p { font-size: 13px; color: #666; margin-bottom: 12px; }
  .error { color: #dc2626; font-size: 13px; margin-bottom: 16px; }
  a { color: #2563eb; }
`;
