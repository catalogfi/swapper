import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import "solidity-coverage";

const config: HardhatUserConfig = {
    solidity: {
        settings: {
            //   viaIR: true,
            optimizer: {
                enabled: true,
                // runs: 100000,
            },
        },
        version: "0.8.18",
    },
    gasReporter: {
        enabled: true,
        currency: "USD",
    },
};

export default config;
