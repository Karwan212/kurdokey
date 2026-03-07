import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCwfbsK4Hve_IqIVUNiOSAxKlbYCBYE8Vk",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "kurdokey-d1889.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "kurdokey-d1889",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "kurdokey-d1889.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "792333169296",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:792333169296:web:69edb6b4d658a633461e15",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-7CYCVD43R9",
};

// Only initialize if we have at least an API key
const hasConfig = !!firebaseConfig.apiKey;

let app;
let auth: any;
let googleProvider: any;
let analytics: any = null;

if (hasConfig) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    
    if (typeof window !== 'undefined') {
      isSupported().then(supported => {
        if (supported) {
          analytics = getAnalytics(app);
        }
      }).catch(err => console.error("Analytics not supported:", err));
    }
  } catch (error) {
    console.error("Firebase initialization failed:", error);
  }
}

export { auth, googleProvider, analytics };
