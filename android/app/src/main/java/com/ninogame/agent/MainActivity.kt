package com.ninogame.agent

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.ninogame.agent.service.AgentService
import com.ninogame.agent.ui.DashboardScreen
import com.ninogame.agent.ui.NinoTheme
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
                            )
                        }
                    }
                }
            }
        }
    }
}

private object Route {
    const val Pair = "pair"
    const val Dashboard = "dashboard"
    const val Tasks = "tasks"
    const val Settings = "settings"
}
