import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import tools.chronicle_sim_v2.gui.main_window  # noqa: F401
print("gui ok")
