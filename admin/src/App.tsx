import { Navigate, Route, Routes } from "react-router-dom";
import { isAuthed } from "./lib/auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Llm from "./pages/Llm";
import Releases from "./pages/Releases";
import AppCategories from "./pages/AppCategories";
import Defaults from "./pages/Defaults";
import System from "./pages/System";
import Push from "./pages/Push";
import Tenants from "./pages/Tenants";
import Changelog from "./pages/Changelog";

function RequireAuth({ children }: { children: JSX.Element }) {
  if (!isAuthed()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/llm" element={<Llm />} />
        <Route path="/releases" element={<Releases />} />
        <Route path="/app-categories" element={<AppCategories />} />
        <Route path="/defaults" element={<Defaults />} />
        <Route path="/system" element={<System />} />
        <Route path="/push" element={<Push />} />
        <Route path="/tenants" element={<Tenants />} />
        <Route path="/changelog" element={<Changelog />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
