import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { createDemoState } from './demo'
import type { AppState } from './types'

const appSlice = createSlice({ name: 'app', initialState: createDemoState(), reducers: { replaceState: (_state, action: PayloadAction<AppState>) => action.payload } })
export const { replaceState } = appSlice.actions
export const store = configureStore({ reducer: { app: appSlice.reducer } })
export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
