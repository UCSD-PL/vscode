# ---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------

import sys
import ast
import bdb
import json
import re
import core
import time
import time
import types
import numpy as np
from PIL import Image

class LoopInfo:
	def __init__(self, frame, lineno, indent):
		self.frame = frame
		self.lineno = lineno
		self.indent = indent
		self.iter = 0

class Logger(bdb.Bdb):
	def __init__(self, lines):
		bdb.Bdb.__init__(self)
		self.lines = lines
		self.time = 0
		self.prev_env = None
		self.data = {}
		self.active_loops = []
		self.preexisting_locals = None
		# self.exception = False

	def data_at(self, l):
		if not(l in self.data):
			self.data[l] = []
		return self.data[l]

	def user_line(self, frame):
		# print("user_line ============================================")
		# print(frame.f_code.co_name)
		# print(frame.f_code.co_names)
		# print(frame.f_code.co_filename)
		# print(frame.f_code.co_firstlineno)
		# print(dir(frame.f_code))
		# print("lineno")
		# print(frame.f_lineno)
		# print(frame.__dir__())
		# print("globals")
		# print(frame.f_globals)
		# print("locals")
		# print(frame.f_locals)

		if frame.f_code.co_name == "<module>" and self.preexisting_locals == None:
			self.preexisting_locals = set(frame.f_locals.keys())

		if frame.f_code.co_name == "<listcomp>" or frame.f_code.co_name == "<dictcomp>" or frame.f_code.co_filename != "<string>":
			return

		# self.exception = False

		adjusted_lineno = frame.f_lineno-1
		self.record_loop_end(frame, adjusted_lineno)
		self.record_env(frame, adjusted_lineno)
		self.record_loop_begin(frame, adjusted_lineno)

	def record_loop_end(self, frame, lineno):
		curr_stmt = self.lines[lineno]
		if self.prev_env != None and len(self.active_loops) > 0 and self.active_loops[-1].frame is frame:
			prev_lineno = self.prev_env["lineno"]
			if isinstance(prev_lineno, str):
				prev_lineno = int(prev_lineno[1:])
			prev_stmt = self.lines[prev_lineno]

			loop_indent = self.active_loops[-1].indent
			curr_indent = indent(curr_stmt)
			if is_return_str(prev_stmt):
				while len(self.active_loops) > 0:
					self.active_loops[-1].iter += 1
					for l in self.stmts_in_loop(self.active_loops[-1].lineno):
						self.data_at(l).append(self.create_end_loop_dummy_env())
					del self.active_loops[-1]
			elif (curr_indent <= loop_indent and lineno != self.active_loops[-1].lineno):
				# break statements don't go through the loop header, so we miss
				# the last increment in iter, which is why we have to adjust here
				if is_break_str(prev_stmt):
					self.active_loops[-1].iter += 1
				for l in self.stmts_in_loop(self.active_loops[-1].lineno):
					self.data_at(l).append(self.create_end_loop_dummy_env())
				del self.active_loops[-1]

	def record_loop_begin(self, frame, lineno):
		# for l in self.active_loops:
		#	 print("Active loop at line " + str(l.lineno) + ", iter " + str(l.iter))
		curr_stmt = self.lines[lineno]
		if is_loop_str(curr_stmt):
			if len(self.active_loops) > 0 and self.active_loops[-1].lineno == lineno:
				self.active_loops[-1].iter += 1
			else:
				self.active_loops.append(LoopInfo(frame, lineno, indent(curr_stmt)))
				for l in self.stmts_in_loop(lineno):
					self.data_at(l).append(self.create_begin_loop_dummy_env())

	def stmts_in_loop(self, lineno):
		result = []
		curr_stmt = self.lines[lineno]
		loop_indent = indent(curr_stmt)
		for l in range(lineno+1, len(self.lines)):
			line = self.lines[l]
			if line.strip() == "":
				continue
			if indent(line) <= loop_indent:
				break
			result.append(l)
		return result

	def active_loops_iter_str(self):
		return ",".join([str(l.iter) for l in self.active_loops])

	def active_loops_id_str(self):
		return ",".join([str(l.lineno) for l in self.active_loops])

	def add_loop_info(self, env):
		env["#"] = self.active_loops_iter_str()
		env["$"] = self.active_loops_id_str()

	def create_begin_loop_dummy_env(self):
		env = {"begin_loop":self.active_loops_iter_str()}
		self.add_loop_info(env)
		return env

	def create_end_loop_dummy_env(self):
		env = {"end_loop":self.active_loops_iter_str()}
		self.add_loop_info(env)
		return env

	def compute_repr(self, v):
		if isinstance(v, types.FunctionType):
			return None
		if isinstance(v, types.ModuleType):
			return None
		html = core.if_img_convert_to_html(v)
		if html == None:
			return repr(v)
		else:
			return f"```html\n{html}\n```"

	def record_env(self, frame, lineno):
		if self.time >= 100:
			self.set_quit()
			return
		env = {}
		env["time"] = self.time
		self.add_loop_info(env)
		self.time = self.time + 1
		for k in frame.f_locals:
			if k != core.magic_var_name and (frame.f_code.co_name != "<module>" or not k in self.preexisting_locals):
				r = self.compute_repr(frame.f_locals[k])
				if (r != None):
					env[k] = self.compute_repr(frame.f_locals[k])
		env["lineno"] = lineno

		self.data_at(lineno).append(env)

		if (self.prev_env != None):
			self.prev_env["next_lineno"] = lineno
			env["prev_lineno"] = self.prev_env["lineno"]

		self.prev_env = env

	# def user_exception(self, frame, e):
	#	 self.exception = True

	def user_return(self, frame, rv):
		# print("user_return ============================================")
		# print(frame.f_code.co_name)
		# print("lineno")
		# print(frame.f_lineno)
		# print(frame.__dir__())
		# print("globals")
		# print(frame.f_globals)
		# print("locals")
		# print(frame.f_locals)

		if frame.f_code.co_name == "<listcomp>" or frame.f_code.co_name == "<dictcomp>" or frame.f_code.co_filename != "<string>":
			return

		# if self.exception:
		#	 if rv == None:
		#		 rv_str = "Exception"
		#	 else:
		#		 rv_str = "Exception(" + repr(rv) + ")"
		# else:
		#	 rv_str = repr(rv)
		adjusted_lineno = frame.f_lineno-1
		# print("About to return: " + self.lines[adjusted_lineno].strip())

		self.record_env(frame, "R" + str(adjusted_lineno))
		#self.data_at("R" + str(adjusted_lineno))[-1]["rv"] = rv_str
		r = self.compute_repr(rv)
		if r != None:
			self.data_at("R" + str(adjusted_lineno))[-1]["rv"] = r
		self.record_loop_end(frame, adjusted_lineno)
		#self.record_loop_begin(frame, adjusted_lineno)

	def pretty_print_data(self):
		for k in self.data:
			print("** Line " + str(k))
			for env in self.data[k]:
				print(env)


class WriteCollector(ast.NodeVisitor):
	def __init__(self):
		ast.NodeVisitor()
		self.data = {}

	def data_at(self, l):
		if not(l in self.data):
			self.data[l] = []
		return self.data[l]

	def record_write(self, lineno, id):
		if (id != core.magic_var_name):
			self.data_at(lineno-1).append(id)

	def visit_Name(self, node):
		#print("Name " + node.id + " @ line " + str(node.lineno) + " col " + str(node.col_offset))
		if isinstance(node.ctx, ast.Store):
			self.record_write(node.lineno, node.id)

	def visit_Subscript(self, node):
		#print("Subscript " + str(node.ctx) + " " + str(node.value) + " " + str(node.col_offset))
		if isinstance(node.ctx, ast.Store):
			id = self.find_id(node)
			if id == None:
				print("Warning: did not find id in subscript")
			else:
				self.record_write(node.lineno, id)

	def find_id(self, node):
		if hasattr(node, "id"):
			return node.id
		if hasattr(node, "value"):
			return self.find_id(node.value)
		return None


def is_loop_str(str):
	return re.search("(for|while).*:", str.strip()) != None

def is_break_str(str):
	return re.search("break", str.strip()) != None

def is_return_str(str):
	return re.search("return", str.strip()) != None

def indent(str):
	return len(str) - len(str.lstrip())

def compute_writes(lines):
	done = False
	i = 0
	while not done:
		try:
			code = "".join(lines)
			# print("Try number " + str(i))
			# print("BEGIN CODE")
			# print(code)
			# print("END CODE")
			i = i + 1
			root = ast.parse(code)
			done = True
		except IndentationError as e:
			lineno = e.lineno-1
			# print(lines[lineno])
			if (lines[lineno].find(core.magic_var_name) == -1):
				raise
			else:
				lines[lineno] = "\n"
	#print(ast.dump(root))
	write_collector = WriteCollector()
	write_collector.visit(root)
	return write_collector.data

def compute_runtime_data(lines):
	code = "".join(lines)
	l = Logger(lines)
	l.run(code)
	#data = adjust_to_next_time_step(l.data)
	return l.data

def adjust_to_next_time_step(data):
	envs_by_time = {}
	for lineno in data:
		for env in data[lineno]:
			if "time" in env:
				envs_by_time[env["time"]] = env
	new_data = {}
	for lineno in data:
		next_envs = []
		for env in data[lineno]:
			if "begin_loop" in env:
				next_envs.append(env)
			elif "end_loop" in env:
				next_envs.append(env)
			elif "time" in env:
				next_time = env["time"]+1
				if next_time in envs_by_time:
					next_envs.append(envs_by_time[next_time])
		new_data[lineno] = next_envs
	return new_data

def main(program) -> str:
	writes = compute_writes(lines)
	run_time_data = compute_runtime_data(lines)
	return json.dumps((writes, run_time_data))
