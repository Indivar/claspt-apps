# Trash

Deleting a page does not remove it. It moves to the vault's trash, where it waits to be restored or removed.

## What goes there

Only deletion. Deleting a page from the sidebar, from the editor, from search, in bulk, by deleting a folder with its pages, or through the local API all send the page to the trash. Editing a page never does: an earlier version of an edited page is in the version history, as before.

## Where it is

`.securenotes/trash/` inside the vault: on this device only, readable only by you, never synced and never indexed. The page file is kept exactly as it was, so its secrets stay encrypted.

## Getting a page back

- Right after deleting, the notice offers **Undo**.
- Later, **Settings › Utilities › Trash** lists every entry with when it was deleted and when it will go. **Restore** puts the page back where it was; if another page has taken that name since, it comes back beside it, in the same folder, recreated if the folder went.

## When it is removed

- **Delete now** on an entry, or **Empty trash**, removes it at once.
- Otherwise the retention decides: **Settings › Editor › Keep deleted pages for**, 7 to 90 days, 30 to start. Entries older than that are removed when the vault is unlocked.

Removing an entry from the trash is not the end of it: the vault's git history still holds every page that ever existed, and the version log can bring it back from there.

## On the phone

The phone is read-only and does not delete pages, so it has no trash.
