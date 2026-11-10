/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Email of the signed-in staff member on /admin pages. */
    staff?: string;
    /** Which part of the admin they may use. */
    staffScope?: import('./server/staff').StaffScope;
    /** The modules they may open, and whether they are an owner. */
    staffModules?: import('./server/staff').Module[];
    staffOwner?: boolean;
    /** Level per module (view, edit, full). */
    staffGrants?: import('./server/staff').Grants;
  }
}
