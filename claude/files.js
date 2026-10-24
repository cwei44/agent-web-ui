'use strict';
const fs = require('fs'), path = require('path');
module.exports = function folderHandler({workspace, secretPaths}, reply) {
function serveFolder(req, res, rawPath) {
  let name;
  try { name = decodeURIComponent(rawPath.slice('/claude/files'.length)); }
  catch { return reply(res, 400, {error: 'Invalid path encoding.'}); }
  if (name.includes('\0') || name.includes('\\') || name.split('/').some(part => part.startsWith('.'))) return reply(res, 403, {error: 'Path not allowed.'});
  const inside = target => target === workspace || target.startsWith(workspace.endsWith(path.sep) ? workspace : workspace + path.sep);
  const permitted = target => inside(target) && !path.relative(workspace, target).split(path.sep).some(part => part.startsWith('.')) &&
    !secretPaths.some(secret => target === secret || target.startsWith(secret + path.sep));
  let fd;
  try {
    const target = fs.realpathSync(path.join(workspace, name));
    if (!permitted(target)) return reply(res, 403, {error: 'Path not allowed.'});
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    // Check the opened object too, so a concurrent symlink swap cannot escape the folder.
    const openedPath = '/proc/self/fd/' + fd;
    if (!permitted(fs.realpathSync(openedPath))) { fs.closeSync(fd); fd = undefined; return reply(res, 403, {error: 'Path not allowed.'}); }
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      const escape = text => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const relative = path.relative(workspace, target);
      const link = entry => '/claude/files/' + entry.split(path.sep).map(encodeURIComponent).join('/');
      const entries = fs.readdirSync(openedPath, {withFileTypes: true}).filter(entry => {
        if (entry.name.startsWith('.')) return false;
        try { return permitted(fs.realpathSync(path.join(openedPath, entry.name))); } catch { return false; }
      }).sort((a,b) => a.name.localeCompare(b.name));
      const rows = entries.map(entry => '<li><a href="' + link(path.join(relative, entry.name)) + '">' + escape(entry.name) + (entry.isDirectory() ? '/' : '') + '</a></li>').join('');
      fs.closeSync(fd); fd = undefined;
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Workspace files</title><h1>Workspace files</h1><p><a href="/claude/">Back to Claude</a></p><p>' + escape('/' + relative) + '</p>' + (relative ? '<a href="' + link(path.dirname(relative) === '.' ? '' : path.dirname(relative)) + '">Parent directory</a>' : '') + '<ul>' + rows + '</ul></html>');
    }
    if (!stat.isFile()) { fs.closeSync(fd); fd = undefined; return reply(res, 403, {error: 'Only regular files can be downloaded.'}); }
    res.writeHead(200, {'Content-Type':'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(target)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))});
    const stream = fs.createReadStream(target, {fd, autoClose:true}); fd = undefined;
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) {
    if (fd !== undefined) fs.closeSync(fd);
    reply(res, ['ENOENT','ENOTDIR'].includes(e.code) ? 404 : 403, {error: 'File is unavailable.'});
  }
}

return serveFolder;
};
