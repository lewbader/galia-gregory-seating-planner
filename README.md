# Galia & Gregory Seating Planner

A Netlify-friendly wedding seating planner.

## Local setup

```bash
npm install
npm run dev
```

## Firebase

Create `.env.local` from `.env.example` and paste the Firebase Web app config.

Enable Google sign-in and Firestore in Firebase. The app syncs to:

```text
seatingPlans/galia-gregory-2026
```

Suggested Firestore rule:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /seatingPlans/{planId} {
      allow read, write: if request.auth != null
        && request.auth.token.email == "lewbader@gmail.com";
    }
  }
}
```

## Netlify

Build command:

```bash
npm run build
```

Publish directory:

```text
dist
```
