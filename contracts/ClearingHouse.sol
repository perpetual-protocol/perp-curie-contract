pragma solidity 0.7.6;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";

contract ClearingHouse is Ownable {
    //
    // events
    //
    event PoolAdded(address base, uint24 feeRatio, address pool);

    //
    // state variables
    //
    address public immutable collateralToken;
    address public immutable quoteToken;
    address public immutable uniswapV3Factory;

    mapping(address => bool) private _poolMap;

    constructor(
        address collateralTokenArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) {
        collateralToken = collateralTokenArg;
        quoteToken = quoteTokenArg;
        uniswapV3Factory = uniV3FactoryArg;
    }

    function addPool(address baseToken, uint24 feeRatio) external onlyOwner {
        address pool = UniswapV3Broker.getPool(uniswapV3Factory, quoteToken, baseToken, feeRatio);
        // CH_NEP: non-existent pool in uniswapV3 factory
        require(pool != address(0), "CH_NEP");
        // CH_EP: existent pool in ClearingHouse
        require(!_poolMap[address(pool)], "CH_EP");

        // update poolMap
        _poolMap[pool] = true;

        emit PoolAdded(baseToken, feeRatio, pool);
    }

    function isPoolExisted(address pool) external view returns (bool) {
        return _poolMap[pool];
    }
}
