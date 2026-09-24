# Attachments

A page can carry files: images (PNG, JPEG, GIF, WebP, SVG) and PDFs. Each one is a decision you make when you attach it, and Claspt tells you what each choice means before the file goes in.

## Attaching a file

Three ways, all the same dialog:

- Click **Attach** in the editor toolbar and pick a file.
- Drag a file onto the page.
- Paste an image from the clipboard.

The dialog shows the file's name and size, then asks one question.

## Encrypt this file?

The box starts **unticked**, and Claspt remembers your last answer for the next file.

- **Unticked:** the file is stored exactly as you gave it. You can open it from the vault folder in Finder, and any tool that reads the folder sees it.
- **Ticked:** the file is sealed under your master key. It opens only inside Claspt. In the vault folder it is unreadable, and it shows a small lock badge in the rendered page.

Either way the file keeps its name and the page's reference to it does not change, so you can encrypt a file later, or remove the encryption, from the rendered page (right-click the image or the file chip).

## The size limit

Each vault has its own limit per attachment, **5 MB** to start, adjustable in Settings between 1 and 25 MB. A file over the limit is not silently shrunk or refused: the dialog states the file's size and the vault's limit and offers two ways forward.

- **Raise the limit** to the size this file needs, if that is within 25 MB.
- **Resize to fit**, for images: you choose the size, format and quality, and see the resulting size before anything is saved.

Claspt never changes a file's bytes on its own. No shrinking, no re-encoding, no metadata stripping. Resizing and converting are things you ask for.

Settings shows how many attachments the vault holds and their total size, beside the limit.

## Where files live

Attachments sit in a `_media` folder beside the pages of the same folder, named by a hash of their content, so attaching the same file twice stores it once. They are part of the vault's git history like everything else.

That has one consequence the attach dialog states every time: **deleting an attachment removes it from the current version only.** Git keeps every earlier version of the vault, so the file stays in the history. The same is true of a page's text; it is worth knowing for a file you would rather not have kept.

## In the rendered page

Images show in the rendered view only, never inside the markdown editor. PDFs are never rendered inline; they appear as a chip with the name and size. Right-click either for:

- **Encrypt this attachment** / **Remove encryption**
- **Save a copy…** — writes the original file wherever you choose, outside the vault
- **Delete attachment…** — with the git note repeated before it happens

## On the phone

The mobile app displays images, encrypted or not, and lists PDFs by name. Attaching from the phone is not available yet.
