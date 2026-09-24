# Passkeys

A passkey signs you into a site with no password at all. Claspt can hold your passkeys in the same vault as everything else, so they work on any machine where that vault is open.

## What a passkey is

When you create a passkey, your device generates a key pair. The site keeps the public half. The private half stays with you and never leaves. Signing in means proving you hold the private half, which the site checks against the public one.

Two things follow from that, and they are the whole point:

- **There is no password to steal.** A breach at the site leaks public keys, which are useless on their own.
- **It cannot be phished.** A passkey is tied to the exact domain it was made for. A lookalike site can ask all it likes; the passkey will not fire. This is the part a two-factor code cannot do, because you can be talked into typing a code into the wrong page.

## Creating one

On a site that offers passkeys, usually under security or sign-in settings:

1. Choose the option to add a passkey.
2. When the browser asks where to save it, choose **Claspt**.
3. It is stored in your vault, in the `passkeys` folder, encrypted like any other secret.

The Claspt browser extension must be installed and connected for Claspt to appear as a choice.

## Seeing what you have

**Settings → Passkeys** in the desktop app lists every passkey in the vault: the site, the account, when it was added, and when it was last used.

The browser extension also shows a line at the top of its list when the site you are on has a passkey saved.

## Signing in

Choose the passkey option on the site. The browser asks Claspt, Claspt signs, and you are in. The vault has to be unlocked.

## Deleting one

**Settings → Passkeys → Delete.**

Read the warning before you confirm. Deleting a passkey in Claspt does not remove it from the site. The site will keep offering it as a sign-in option that can no longer work, so remove it in the site's own security settings too, and make sure you still have another way in before you do either.

## What Claspt stores, and what it does not

Stored in the vault, encrypted: the private key, the credential id, the site, and the account name.

Not stored anywhere: anything that would let a site identify you across other sites. Each passkey is specific to the site it was made for.

## Limits worth knowing

- Passkeys in Claspt work wherever the vault is open and the extension is connected. They are not in your operating system's keychain, so another browser profile without the extension will not see them.
- If you lose access to the vault, you lose the passkeys with it. Keep your recovery key, and keep a second sign-in method on any account that matters.
