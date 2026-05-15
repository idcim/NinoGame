package com.ninogame.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.ninogame.agent.service.AgentService
import com.ninogame.agent.service.AgentState
import com.ninogame.agent.ui.ChangelogScreen
import com.ninogame.agent.ui.DashboardScreen
import com.ninogame.agent.ui.LedgerScreen
import com.ninogame.agent.ui.MessagesScreen
import com.ninogame.agent.ui.NinoTheme
import com.ninogame.agent.ui.OutOfTokenScreen
import com.ninogame.agent.ui.PairScreen
import com.ninogame.agent.ui.SettingsScreen
import com.ninogame.agent.ui.TasksScreen

class MainActivity : ComponentActivity() {

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            NinoTheme {
                val windowSize = calculateWindowSizeClass(this)
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    val nav = rememberNavController()
                    val paired by ninoSettings.isPaired.collectAsState(initial = false)
                    val start = if (paired) Route.Dashboard else Route.Pair

                    val ctx = LocalContext.current
                    LaunchedEffect(paired) {
                        if (paired) AgentService.start(ctx)
                        else AgentService.stop(ctx)
                    }

                    // v0.5.16: outOfToken overlay 叠在所有 Screen 顶层. balance≤0 + Child +
                    // 非限免 时, NavHost 内容仍渲染但被半透蒙层 + 卡片盖住, 触摸被拦.
                    val outOfToken by AgentState.outOfToken.collectAsState()

                    Box(modifier = Modifier.fillMaxSize()) {
                        AppNavHost(nav = nav, windowSize = windowSize, start = start)
                        if (outOfToken) {
                            OutOfTokenScreen()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AppNavHost(
    nav: NavHostController,
    windowSize: WindowSizeClass,
    start: String,
) {
    NavHost(navController = nav, startDestination = start) {
        composable(Route.Pair) {
            PairScreen(
                windowSize = windowSize,
                onPaired = {
                    nav.navigate(Route.Dashboard) {
                        popUpTo(Route.Pair) { inclusive = true }
                    }
                },
            )
        }
        composable(Route.Dashboard) {
            DashboardScreen(
                windowSize = windowSize,
                onOpenTasks = { nav.navigate(Route.Tasks) },
                onOpenSettings = { nav.navigate(Route.Settings) },
            )
        }
        composable(Route.Tasks) {
            TasksScreen(
                windowSize = windowSize,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Route.Settings) {
            SettingsScreen(
                windowSize = windowSize,
                onBack = { nav.popBackStack() },
                onResetPair = {
                    nav.navigate(Route.Pair) {
                        popUpTo(Route.Dashboard) { inclusive = true }
                    }
                },
                onOpenChangelog = { nav.navigate(Route.Changelog) },
                onOpenMessages = { nav.navigate(Route.Messages) },
                onOpenLedger = { nav.navigate(Route.Ledger) },
            )
        }
        composable(Route.Changelog) {
            ChangelogScreen(
                windowSize = windowSize,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Route.Messages) {
            MessagesScreen(
                windowSize = windowSize,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Route.Ledger) {
            LedgerScreen(
                windowSize = windowSize,
                onBack = { nav.popBackStack() },
            )
        }
    }
}

private object Route {
    const val Pair = "pair"
    const val Dashboard = "dashboard"
    const val Tasks = "tasks"
    const val Settings = "settings"
    const val Changelog = "changelog"
    const val Messages = "messages"
    const val Ledger = "ledger"
}
