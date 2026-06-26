import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { apiFetch, getStoredToken, getStoredUsername, setStoredAuth, clearStoredAuth } from '../../shared/api';

export type AuthState = {
  token: string | null;
  username: string | null;
  loading: boolean;
  error: string | null;
};

const initialState: AuthState = {
  token: getStoredToken(),
  username: getStoredUsername(),
  loading: false,
  error: null,
};

type AuthResponse = {
  id: string;
  username: string;
  token: string;
};

export const register = createAsyncThunk('auth/register', async (payload: { username: string; password: string }) => {
  return apiFetch<AuthResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
});

export const login = createAsyncThunk('auth/login', async (payload: { username: string; password: string }) => {
  return apiFetch<AuthResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    logout(state) {
      state.token = null;
      state.username = null;
      clearStoredAuth();
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(register.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(register.fulfilled, (state, action) => {
        state.loading = false;
        state.token = action.payload.token;
        state.username = action.payload.username;
        setStoredAuth(action.payload.token, action.payload.username);
      })
      .addCase(register.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || '注册失败';
      })
      .addCase(login.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.loading = false;
        state.token = action.payload.token;
        state.username = action.payload.username;
        setStoredAuth(action.payload.token, action.payload.username);
      })
      .addCase(login.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || '登录失败';
      });
  },
});

export const { logout } = authSlice.actions;
export default authSlice.reducer;
