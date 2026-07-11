import sys
from pathlib import Path

# fixture_retriever lives beside the tests, outside any installed package.
sys.path.insert(0, str(Path(__file__).parent))
