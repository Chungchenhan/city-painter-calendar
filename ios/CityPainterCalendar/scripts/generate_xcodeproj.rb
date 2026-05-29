#!/usr/bin/env ruby
# frozen_string_literal: true

gem 'xcodeproj'
require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(ROOT, 'CityPainterCalendar.xcodeproj')
PROJECT_NAME = 'CityPainterCalendar'
APP_TARGET = 'CityPainterCalendarApp'
WIDGET_TARGET = 'CityPainterCalendarWidget'
DEPLOYMENT_TARGET = '17.0'
DEVELOPMENT_TEAM = 'YMV24PTPJ5'

FileUtils.rm_rf(PROJECT_PATH)
project = Xcodeproj::Project.new(PROJECT_PATH)
project.root_object.development_region = 'zh-Hant'
project.root_object.known_regions = ['zh-Hant', 'Base']

project.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
  config.build_settings['MARKETING_VERSION'] = '0.1.0'
  config.build_settings['CURRENT_PROJECT_VERSION'] = '2'
  config.build_settings['SWIFT_VERSION'] = '5.0'
end

app_target = project.new_target(:application, APP_TARGET, :ios, DEPLOYMENT_TARGET)
widget_target = project.new_target(:app_extension, WIDGET_TARGET, :ios, DEPLOYMENT_TARGET)

def configure_target(target, bundle_id, plist)
  target.build_configurations.each do |config|
    config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = bundle_id
    config.build_settings['INFOPLIST_FILE'] = plist
    config.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
    config.build_settings['SWIFT_VERSION'] = '5.0'
    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
    config.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
    config.build_settings['DEVELOPMENT_TEAM'] = DEVELOPMENT_TEAM
    config.build_settings['ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS'] = 'YES'
  end
end

configure_target(
  app_target,
  'com.citypainter.calendar',
  'CityPainterCalendarApp/Info.plist'
)
configure_target(
  widget_target,
  'com.citypainter.calendar.widget',
  'CityPainterCalendarWidget/Info.plist'
)

app_group = project.main_group.new_group('CityPainterCalendarApp', 'CityPainterCalendarApp')
widget_group = project.main_group.new_group('CityPainterCalendarWidget', 'CityPainterCalendarWidget')
shared_group = project.main_group.new_group('Shared', 'Shared')

def add_sources(group, target, files)
  files.each do |file|
    ref = group.new_file(file)
    target.add_file_references([ref])
  end
end

add_sources(app_group, app_target, [
  'CityPainterCalendarApp.swift',
  'WebCalendarView.swift'
])
add_sources(widget_group, widget_target, [
  'CityPainterCalendarWidget.swift',
  'WidgetModels.swift'
])

shared_ref = shared_group.new_file('WidgetConfig.swift')
app_target.add_file_references([shared_ref])
widget_target.add_file_references([shared_ref])

assets_ref = app_group.new_file('Assets.xcassets')
app_target.resources_build_phase.add_file_reference(assets_ref)
app_target.build_configurations.each do |config|
  config.build_settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  config.build_settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
end

[app_target, widget_target].each do |target|
  target.frameworks_build_phase.add_file_reference(project.frameworks_group.new_file('SwiftUI.framework'))
end
app_target.frameworks_build_phase.add_file_reference(project.frameworks_group.new_file('WebKit.framework'))
widget_target.frameworks_build_phase.add_file_reference(project.frameworks_group.new_file('WidgetKit.framework'))

app_target.add_dependency(widget_target)
embed_phase = app_target.new_copy_files_build_phase('Embed App Extensions')
embed_phase.symbol_dst_subfolder_spec = :plug_ins
embed_phase.add_file_reference(widget_target.product_reference)

project.save
puts "Generated #{PROJECT_PATH}"
