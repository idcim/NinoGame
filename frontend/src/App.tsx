import { Navigate, Route, Routes } from "react-router-dom";
import { isAuthed } from "./lib/auth";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import DeviceDetail from "./pages/DeviceDetail";
import Rules from "./pages/Rules";
import Layout from "./components/Layout";

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
        <Route path="/rules" element={<Rules />} />
        <Route path="/device/:id" element={<DeviceDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
