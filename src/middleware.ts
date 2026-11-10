import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { accessEmail, adminModule, homeFor, mayDo, mayOpenPath, noAccessResponse, notStaffResponse, sessionEmail, staffAccess, viewOnlyResponse } from './server/staff';
import { sameOrigin } from './server/session';

// Everything under /admin is for staff only, never cached and never indexed.
export const onRequest = defineMiddleware(async (context, next) => {
  if (!context.url.pathname.startsWith('/admin')) return next();

  const access = await staffAccess(context.request, env);
  if (!access) {
    const who = (await accessEmail(context.request, env)) ?? (await sessionEmail(context.request, env));
    // Not signed in at all: sign in like anyone else, then come back here.
    if (!who) return context.redirect(`/account?return=${encodeURIComponent(context.url.pathname)}`, 302);
    return notStaffResponse(who);
  }
  if (context.request.method !== 'GET' && !sameOrigin(context.request)) {
    return new Response('Bad origin', { status: 403 });
  }
  // Team members open only the modules an owner gave them.
  const module = adminModule(context.url.pathname);
  if (context.url.pathname === '/admin' || context.url.pathname === '/admin/') return context.redirect(homeFor(access), 302);
  if (!mayOpenPath(access, context.url.pathname)) {
    if (context.url.pathname.startsWith('/admin/dashboard')) return context.redirect(homeFor(access), 302);
    return noAccessResponse(homeFor(access));
  }
  // "View only" in a module: its pages open, but nothing can be saved there.
  if (context.request.method !== 'GET' && module !== 'shared' && module !== 'owner' && !mayDo(access, module, 'edit')) {
    return viewOnlyResponse(context.url.pathname);
  }
  context.locals.staff = access.email;
  context.locals.staffScope = access.scope;
  context.locals.staffModules = access.modules;
  context.locals.staffOwner = access.owner;
  context.locals.staffGrants = access.grants;
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex');
  return response;
});
