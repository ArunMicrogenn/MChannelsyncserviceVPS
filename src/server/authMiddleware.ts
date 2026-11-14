import type { Request, Response, NextFunction } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from './firebaseAdmin.ts';
import { fsGetDoc, fsSetDoc } from './firestoreRest.ts';

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
  idToken?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing Bearer token' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Empty token' });
    return;
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.user = decoded;
    req.idToken = token;

    // Ensure operator profile exists in Firestore via user-scoped REST API (best-effort)
    try {
      const existing = await fsGetDoc(token, `users/${decoded.uid}`);
      if (!existing) {
        await fsSetDoc(
          token,
          `users/${decoded.uid}`,
          {
            uid: decoded.uid,
            email: decoded.email ?? '',
            displayName: decoded.name ?? decoded.email ?? 'Operator',
          },
          { serverTimeFields: ['createdAt'] }
        );
      }
    } catch (userSyncErr) {
      console.warn('Operator profile sync warning:', userSyncErr);
    }

    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    res.status(401).json({ error: 'Unauthorized: Invalid or expired Firebase token' });
  }
}
