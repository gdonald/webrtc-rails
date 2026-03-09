Rails.application.routes.draw do
  root "rooms#index"
  resources :rooms, only: [ :index, :show ]

  get "up" => "rails/health#show", as: :rails_health_check
end
