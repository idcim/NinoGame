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
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.ninogame.agent.ui.DashboardScreen
import com.ninogame.agent.ui.NinoTheme
import com.ninogame.agent.ui.PairScreen

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
                    // 起始页根据"是否已配对"决定. 用 settings flow 的初值;
                    // 切换路由在各自 Screen 完成动作后调 nav.navigate.
                    val paired by ninoSettings.isPaired.collectAsState(initial = false)
                    val start = if (paired) Route.Dashboard else Route.Pair

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
}
