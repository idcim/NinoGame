import { Navigate, Route, Routes } from "react-router-dom";
import { isAuthed } from "./lib/auth";
import About from "./pages/About";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import DeviceDetail from "./pages/DeviceDetail";
import Requests from "./pages/Requests";
import Rules from "./pages/Rules";
import Tasks from "./pages/Tasks";
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
        <Route path="/requests" element={<Requests />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/device/:id" element={<DeviceDetail />} />
        <Route path="/about" element={<About />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
