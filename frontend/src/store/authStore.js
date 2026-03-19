import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const API_BASE = '/api';

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      
      login: async (email, password) => {
        try {
          const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Login failed');
          }

          const data = await response.json();
          
          set({ 
            user: data.user, 
            token: data.token 
          });
          
          return data;
        } catch (error) {
          console.error('Login error:', error);
          throw error;
        }
      },

      signup: async (email, password, name) => {
        try {
          const response = await fetch(`${API_BASE}/auth/signup`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password, name }),
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Signup failed');
          }

          const data = await response.json();
          
          if (data.session) {
            set({ 
              user: data.user, 
              token: data.session.access_token 
            });
          }
          
          return data;
        } catch (error) {
          console.error('Signup error:', error);
          throw error;
        }
      },

      logout: () => {
        set({ user: null, token: null });
      },

      checkAuth: async () => {
        const { token } = get();
        if (!token) return false;

        try {
          const response = await fetch(`${API_BASE}/documents`, {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          });

          if (!response.ok) {
            set({ user: null, token: null });
            return false;
          }

          return true;
        } catch (error) {
          set({ user: null, token: null });
          return false;
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ 
        user: state.user, 
        token: state.token 
      }),
    }
  )
);