# AdScience (Encrypted Attention Exchange)

AdScience is a privacy-preserving advertising framework that uses On-Device ML and Fully Homomorphic Encryption (FHE) to match user interests with advertisements without leaking user data.

## Project Structure

This repository is organized as a monorepo containing the following components:

- **/base**: The core legacy implementation including:
  - **extension**: Chrome extension for on-device interest vector generation.
  - **backend**: Server for managing ad submissions and reward distribution.
  - **contracts**: Smart contracts for the EAX protocol (Foundry).
  - **eax-sdk**: Shared logic for encryption and contract interaction.
- **/super_new_new_frontend**: The modern, revamped user interface and dashboard.
- **/meow**: Experimental/scratch frontend components.

## Deployment Details

### Smart Contract Addresses
- **EAX Protocol Contract**: `0x33786a4bee9587b673e874b8f8a07e11f2d23820`
- **ERC-20 (ADAI) Token**: `0x4b5af68fa19759806f78235b535cd50d69979838`

## Development

Please refer to the `README.md` files within each subdirectory for specific setup and development instructions.
