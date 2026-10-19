# Jev Browser Agent

A Chrome extension (Manifest V3) that does tasks in your browser from a one-line prompt.
DeepSeek plans each step; TypeSafe Jev picks the element from the page and screenshot.

```
book ltt to sc 21oct 3ac 12219 rahul/31/m/lb/veg on irctc, wait on payment page
mmt fli8 ixr to blr 24nov cheapest me@example.com ms Priya Sharma, f, 05.03.1995, 9876543210 wait at payment, no addon
```

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder.
2. Open the side panel (toolbar icon or `Alt+J`), then **Settings**: paste your TypeSafe and DeepSeek API keys and press **Test connection**.
3. Type a prompt in the side panel and press **Run task**.

## What it handles

- **Real input**: clicks and typing go through `chrome.debugger`, so sites that ignore scripted events (MakeMyTrip) respond. Chrome shows a "started debugging" bar while a task runs.
- **Forms**: one-step `fill` for whole forms, searchable dropdowns (react-select: date of birth, country code), styled radios/checkboxes, read-only boxes that open a real input, off-screen fields, and form validation errors (fixed before pressing Continue again).
- **IRCTC**: station/class/berth shorthand, a fast path for the search form, train-card context for "Book Now"/class boxes, not-available classes (asks which class instead), saved-login sign-in, captcha hand-off, restart on "Sorry!!! Please Try again!!", instant retry on "server busy" toasts.
- **MakeMyTrip**: direct results URL, cheapest fare, new-tab follow, traveller details, no add-ons.
- **Loops**: repeated actions are detected; dead elements and pointless scrolling get blocked.

## What it won't do

- **Pay**: it always stops on the payment page and hands over to you.
- **Solve captchas or OTPs**: you type them; the agent carries on by itself once they're filled.
- **Send your password to the models**: `password …` in a prompt is replaced with `{{PASSWORD}}` and only typed into the page.
- **Touch extras you didn't ask for**: GST details, MakeMyTrip's paid LOCK NOW, insurance and add-ons when you say "no addon".

## Files

| File | What it does |
| --- | --- |
| `background.js` | Agent loop: plan (DeepSeek), ground (Jev), act, guards, site fast paths |
| `content.js` | Page side: element list, actions, form errors, dropdown pickers |
| `lib/` | API clients (TypeSafe, DeepSeek), settings, screenshot prep, password redaction |
| `sidepanel.*`, `options.*` | UI |
