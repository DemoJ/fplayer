package com.fplayer.tv.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fplayer.tv.core.AppContainer
import com.fplayer.tv.data.Work
import com.fplayer.tv.ui.common.WorkGrid
import kotlinx.coroutines.delay

/**
 * 搜索页：输入防抖搜索作品，Done 后焦点进入结果网格。
 */
@Composable
fun SearchScreen(
    onWorkClick: (Work) -> Unit,
) {
    val api = AppContainer.apiClient.api
    val inputFocus = remember { FocusRequester() }
    val gridFocus = remember { FocusRequester() }
    var query by remember { mutableStateOf("") }
    var items by remember { mutableStateOf<List<Work>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }

    LaunchedEffect(query) {
        if (query.isBlank()) {
            items = emptyList()
            searched = false
            return@LaunchedEffect
        }
        searching = true
        delay(400)
        runCatching { api.works(q = query, limit = 120) }
            .onSuccess { r -> items = r.items; searched = true }
        searching = false
    }

    LaunchedEffect(Unit) { inputFocus.requestFocus() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0E0E10))
            .padding(start = 36.dp, end = 36.dp, top = 32.dp),
    ) {
        Text(
            text = "搜索",
            color = Color.White,
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(20.dp))
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(inputFocus),
            placeholder = { Text("搜索片名") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { gridFocus.requestFocus() }),
        )
        Spacer(Modifier.height(22.dp))

        when {
            searching -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("搜索中...", color = Color(0xFF6E6E74), fontSize = 15.sp)
            }
            searched && items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("未找到与「$query」相关的作品", color = Color(0xFF6E6E74), fontSize = 15.sp)
            }
            items.isNotEmpty() -> WorkGrid(
                items = items,
                onItemClick = onWorkClick,
                modifier = Modifier.weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
                firstItemFocusRequester = gridFocus,
            )
            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("输入片名开始搜索", color = Color(0xFF6E6E74), fontSize = 15.sp)
            }
        }
    }
}