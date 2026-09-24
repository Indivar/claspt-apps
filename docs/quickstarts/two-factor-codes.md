# Two-factor codes (TOTP)

Claspt generates the six-digit codes that sites ask for after your password, the same ones Google Authenticator, Authy and Microsoft Authenticator produce. It fills them in for you alongside the password, so you do not reach for your phone.

## What a two-factor code actually is

When a site offers two-factor, it shows you a QR image once. That image is a short piece of text: a random **key**, plus the settings (six digits, thirty seconds). Your authenticator stores the key, and so does the site.

From then on, both sides take the key and the current time, run them through the same one-way function, and six digits fall out. Nothing is sent between them. That is why an authenticator works with no signal, and why a badly wrong device clock breaks the codes.

## Adding one, from the browser

The quickest way, on the site's two-factor setup page while the QR is on screen:

1. Click the Claspt extension icon.
2. Find the credential for this site and click **Set up two-factor**.
3. Claspt reads the QR code off the page and shows you what it found.
4. Click **Save it**. The site will then ask you to confirm a code, and the extension can fill that too.

The screenshot is decoded inside the extension and thrown away. It is never stored and never uploaded.

If the QR is scrolled off screen, or the page will not let the extension capture it, choose **paste a key instead** and use the site's own "can't scan the code?" link, which shows the same key as text.

## Adding one, in the app

1. In the page for that login, insert a **Website Login** secret block.
2. Put the key in **Authenticator Key**. It takes either the `otpauth://` link behind the QR image or the bare key the site shows.
3. A live code appears underneath as you type. **Check it matches the code the site is showing you** before you save. If it does not, the key was pasted wrong.

## Where the key is stored

In the credential's `totp` field, inside the encrypted `:::secret` block, like any other secret value. These spellings are also read, for keys that arrived from an import: `otp`, `otp_secret`, `authenticator`, `2fa`. Claspt writes `totp`.

**Backup Codes** is a different field and a different thing: the one-time codes a site gives you in case you lose your device. They are not used to generate anything.

## Using a code

- **In the browser.** Fill the credential as usual. When the site asks for the code, the extension fills the current one.
- **From the popup.** Open the extension, find the credential, and the live code is shown with a ring counting down the seconds it has left. Click **Copy**.

## What this trades away

Keeping the two-factor key in the same vault as the password means anyone who opens your vault has both factors. Every password manager that offers this makes the same trade, and it is a real one. If you want the two factors genuinely separate, keep the key in a separate authenticator app and use Claspt for the password only.

Two-factor codes also do not stop phishing on their own. A convincing fake login page can ask for your code and use it on the real site within the thirty seconds it lives. A passkey cannot be used this way, because it is bound to the real domain. See [Passkeys](passkeys.md).
