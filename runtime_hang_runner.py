import faulthandler, sys, unittest
with open('runtime_hang_trace.txt', 'w', encoding='utf-8') as f:
    faulthandler.enable(file=f)
    faulthandler.dump_traceback_later(5, repeat=False, file=f)
    suite = unittest.defaultTestLoader.loadTestsFromName('tools.editor.tests.test_production_workbench_story_unit_gui.ProductionWorkbenchStoryUnitGuiTests.test_runtime_debug_tab_uses_scene_picker_for_switch_scene')
    runner = unittest.TextTestRunner(stream=f, verbosity=2)
    result = runner.run(suite)
    sys.exit(not result.wasSuccessful())
