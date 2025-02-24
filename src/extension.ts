import { commands, window, workspace, ExtensionContext, Uri, env, ConfigurationTarget, InputBoxOptions } from "vscode"
import { TodoistApi, Task, Project, AddTaskArgs } from "@doist/todoist-api-typescript"

const TodoistClient = new TodoistApi('')
type TaskQPI = Task & { label: string }
type ProjectQPI = Project & { label: string }
type Scope = 'project' | 'global' | null
const priorities = [4, 3, 2, 1]

const getApiToken = async (context: ExtensionContext) => {
    const apiToken = await context.secrets.get('todoistApiToken')
    if (apiToken) {
        return apiToken
    }

    const newApiToken = await window.showInputBox({ placeHolder: 'Enter your Todoist API Token', password: true })
    if (!newApiToken) {
        return null
    }

    context.secrets.store('todoistApiToken', newApiToken)
    return newApiToken
}

const getOrCreateProjectId = async ({ apiToken, scope }: { apiToken: string, scope: Scope }) => {
    if (scope === 'project' && !workspace.workspaceFolders) {
        window.showWarningMessage('Not within a workspace')
        return null
    }

    let projectId = workspace.getConfiguration().get('todoist.projectId')
    if (projectId) {
        return typeof projectId === 'number' ? String(projectId) : (projectId as string)
    }

    TodoistClient.authToken = apiToken
    const projects = await TodoistClient.getProjects()

    const projectQPIs = projects.map((project) =>
        Object.assign(project, { label: project.name })
    )

    const configTarget = scope === 'project' ? ConfigurationTarget.Workspace : ConfigurationTarget.Global
    const quickPick = window.createQuickPick<ProjectQPI | { label: string, id: null }>()
    quickPick.placeholder = 'Choose a Todoist Project for this workspace'

    quickPick.items = [...projectQPIs, { label: 'Create a new project', id: null }]
    quickPick.onDidChangeSelection(async items => {
        projectId = items[0].id
        if (projectId) {
            await workspace.getConfiguration().update('todoist.projectId', projectId, configTarget)
        }
        else {
            const inputString = await window.showInputBox({ placeHolder: 'Enter Todoist Project Name' })
            if (!inputString) {
                return
            }

            const project = await TodoistClient.addProject({ name: inputString })
            await workspace.getConfiguration().update('todoist.projectId', project.id, configTarget)
        }
        quickPick.dispose()
    })
    quickPick.onDidHide(() => quickPick.dispose())
    quickPick.show()
    return null
}

const taskLabel = (task: Task) => {
    const statusBox = task.isCompleted ? '✔️ ' : ''
    return `${statusBox}${task.content}`
}

const taskDetail = (task: Task) => {
    var labels = task.labels
    for (var i = 0; i < labels.length; i++) {
        labels[i] = '@' + labels[i]
    }

    const labelsString = labels.join(' • ')
    const priorityString = task.priority ? 'P' + priorities[task.priority - 1] : ''
    const detail = priorityString + (priorityString !== '' && labelsString !== '' ? ' • ' : '') + labelsString
    return detail
}

const makeTaskQPIs = (tasks: Array<Task | TaskQPI>): TaskQPI[] => tasks.map(
    task => Object.assign(task, { label: taskLabel(task), detail: taskDetail(task), picked: task.isCompleted })
)

type CommandOptions = {
    context: ExtensionContext,
    scope?: Scope,
    customProjectId?: string
}

const captureTodo = async ({ scope = null, customProjectId, context }: CommandOptions) => {
    const apiToken = await getApiToken(context)
    if (!apiToken) {
        return
    }

    const projectId = customProjectId ? customProjectId : await getOrCreateProjectId({ apiToken, scope })
    if (!projectId) {
        return
    }

    const activeSelection = window.activeTextEditor?.selection
    var fileLink = ''
    var lineNumber = 0
    if (activeSelection && !activeSelection.isEmpty && env.appHost === 'desktop') {
        const fileName = window.activeTextEditor?.document.fileName
        lineNumber = activeSelection.start.line + 1
        fileLink = `${env.uriScheme}://file/${fileName}:${lineNumber}`
    }

    const inputBoxOptions: InputBoxOptions = {
        prompt: 'Try @label and !!1-4' + (fileLink === '' ? '' : ` • 🔗 Line ${lineNumber}`),
        placeHolder: 'Enter Todo',
        valueSelection: [0, 0]
    }

    const inputString = await window.showInputBox(inputBoxOptions)
    if (!inputString) {
        return
    }

    var cleanedInput = inputString
    var labels: string[] = []
    var priority = 0;

    const regexpNoSpaces = new RegExp(/(\s|^)@([^\s"][\S]+)/g)
    const regexpDoubleQuotes = new RegExp(/(\s|^)@"([^"]+)"(\s|$)/g)
    const regexpSingleQuotes = new RegExp(/(\s|^)@'([^"]+)'(\s|$)/g)
    const regexpPriority = new RegExp(/(\s|^)!!(0|1|2|3|4)(\s|$)/g)

    let match
    while ((match = regexpNoSpaces.exec(cleanedInput)) !== null) {
        var foundLabel = match[0].trim().replace('@', '')
        if (!labels.includes(foundLabel)) {
            labels.push(match[0].trim().replace('@', ''))
        }
    }
    cleanedInput = cleanedInput.replace(regexpNoSpaces, '').trim()

    while ((match = regexpDoubleQuotes.exec(cleanedInput)) !== null) {
        var foundLabel = match[0].trim().replace('@"', '').replace('"', '')
        if (!labels.includes(foundLabel)) {
            labels.push(foundLabel);
        }
    }
    cleanedInput = cleanedInput.replace(regexpDoubleQuotes, '').trim()

    while ((match = regexpSingleQuotes.exec(cleanedInput)) !== null) {
        var foundLabel = match[0].trim().replace("@'", '').replace("'", "")
        if (!labels.includes(foundLabel)) {
            labels.push(foundLabel);
        }
    }
    cleanedInput = cleanedInput.replace(regexpSingleQuotes, '').trim()

    while ((match = regexpPriority.exec(cleanedInput)) !== null) {
        var foundPriority = parseInt(match[0].trim().replace('!!', ''))
        if (foundPriority) {
            priority = foundPriority
        }
    }
    cleanedInput = cleanedInput.replace(regexpPriority, '').trim()

    let body: AddTaskArgs = {
        content: cleanedInput,
        projectId,
        description: fileLink,
        labels: labels
    }

    if (priority) {
        body.priority = priorities[priority - 1]
    }

    TodoistClient.authToken = apiToken
    const task = await TodoistClient.addTask(body).catch(() => null)

    if (!task) {
        return window.showWarningMessage('There was an error creating the task')
    }

    const actionOpen = 'Edit'
    const actionUndo = 'Undo'
    const userResponse = await window.showInformationMessage('Task created', ...[actionOpen, actionUndo])

    if (userResponse === actionOpen) {
        env.openExternal(Uri.parse(`todoist://task?id=${task.id}`))
    }
    else if (userResponse === actionUndo) {
        const result = await TodoistClient.deleteTask(task.id)
        if (result) {
            window.showInformationMessage('Task deleted')
        }
        else {
            window.showWarningMessage('There was an error deleting the task')
        }
    }
}

const listTodos = async ({ scope = null, customProjectId, context }: CommandOptions) => {
    const apiToken = await getApiToken(context)
    if (!apiToken) {
        return
    }

    const projectId = customProjectId ? customProjectId : await getOrCreateProjectId({ apiToken, scope })
    if (!projectId) {
        return
    }

    const quickPick = window.createQuickPick<TaskQPI>()
    quickPick.matchOnDetail = true
    quickPick.busy = true
    quickPick.placeholder = 'Loading...'
    quickPick.show()

    TodoistClient.authToken = apiToken
    const tasks = await TodoistClient.getTasks({ projectId })
    let quickPickItems = makeTaskQPIs(tasks)
    quickPick.busy = false
    quickPick.placeholder = ''
    quickPick.items = quickPickItems
    quickPick.onDidChangeSelection(items => {
        const itemIds = items.map(item => item.id)
        quickPick.items.forEach((item: TaskQPI) => {
            if (itemIds.includes(item.id)) {
                showEditTask(item, context)
                quickPick.hide()
            }
        })
    })
    quickPick.onDidHide(() => quickPick.dispose())
}

const showEditTask = async (task: TaskQPI, context: ExtensionContext) => {
    const actionOpen = 'Open'
    const actionToggle = task.isCompleted ? 'Uncomplete' : 'Complete'
    const userResponse = await window.showInformationMessage(trimString(task.content, 45), ...[actionOpen, actionToggle])

    if (userResponse === actionOpen) {
        env.openExternal(Uri.parse(`todoist://task?id=${task.id}`))
    }
    else if (userResponse === actionToggle) {
        const apiToken = await getApiToken(context)
        if (!apiToken) {
            return
        }

        TodoistClient.authToken = apiToken
        var result = false
        var message = 'Task updated'
        if (task.isCompleted) {
            result = await TodoistClient.reopenTask(task.id)
            message = 'Task marked as not completed'
        }
        else {
            result = await TodoistClient.closeTask(task.id)
            message = 'Task marked as completed'
        }

        if (result) {
            window.showInformationMessage(message)
        }
        else {
            window.showWarningMessage('There was an error updating the task')
        }
    }
}

const openProject = async ({ scope = null, customProjectId, context }: CommandOptions) => {
    const apiToken = await getApiToken(context)
    if (!apiToken) {
        return
    }

    const projectId = customProjectId ? customProjectId : await getOrCreateProjectId({ apiToken, scope })
    if (!projectId) {
        return
    }

    env.openExternal(Uri.parse(`todoist://project?id=${projectId}`))
}

const modifyToken = async ({ context }: CommandOptions) => {
    const newApiToken = await window.showInputBox({ placeHolder: 'Enter your Todoist API token', password: true })
    if (!newApiToken) {
        return null
    }

    context.secrets.store('todoistApiToken', newApiToken)
}

const getCommandHandlers = (context: ExtensionContext) => ({
    'extension.todoistModifyToken': () => modifyToken({ context }),

    'extension.todoistCaptureProject': () => captureTodo({ scope: 'project', context }),
    'extension.todoistCaptureGlobal': () => captureTodo({ scope: 'global', context }),
    'extension.todoistCaptureId': (projectId: string) => captureTodo({ customProjectId: projectId, context }),

    'extension.todoistTodosProject': () => listTodos({ scope: 'project', context }),
    'extension.todoistTodosGlobal': () => listTodos({ scope: 'global', context }),
    'extension.todoistTodosId': (projectId: string) => listTodos({ customProjectId: projectId, context }),

    'extension.todoistOpenProject': () => openProject({ scope: 'project', context }),
    'extension.todoistOpenGlobal': () => openProject({ scope: 'global', context }),
    'extension.todoistOpenId': (projectId: string) => openProject({ customProjectId: projectId, context })
})

const trimString = (str: string, maxLen: number) => {
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

export function activate(context: ExtensionContext) {
    const commandHandlers = getCommandHandlers(context)

    Object.entries(commandHandlers).forEach(([command, handler]) => {
        const disposable = commands.registerCommand(command, handler)
        context.subscriptions.push(disposable)
    })
}

export function deactivate() {
    // Unregister handler?
}
